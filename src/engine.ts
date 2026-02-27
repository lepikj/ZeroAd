/**
 * ZeroAd: Sync Engine (Core Logic & State Machine)
 */

import { Bindings, SyncStatus, KV_KEYS, CONFIG, ChunksMeta } from "./types";
import {
  getGatewayLists,
  createOrUpdateGatewayList,
  updateGatewayPolicy,
  deleteGatewayList,
} from "./api";
import { fetchAdBlockList } from "./parser";

export type ProgressCallback = (
  msg: string,
  type?: string,
  meta?: any,
) => Promise<void>;

export class SyncEngine {
  constructor(private env: Bindings) {}

  /**
   * Updates the heartbeat to signal active processing.
   */
  async updateHeartbeat() {
    await this.env.ADBLOCK_KV.put(KV_KEYS.HEARTBEAT, Date.now().toString());
  }

  /**
   * Clears the heartbeat signal.
   */
  async clearHeartbeat() {
    await this.env.ADBLOCK_KV.delete(KV_KEYS.HEARTBEAT);
  }

  /**
   * Checks if another worker process is currently active.
   */
  async isLocked(): Promise<boolean> {
    const lastHeartbeat = await this.env.ADBLOCK_KV.get(KV_KEYS.HEARTBEAT);
    if (!lastHeartbeat) return false;
    return Date.now() - parseInt(lastHeartbeat) < CONFIG.HEARTBEAT_TTL_MS;
  }

  /**
   * Returns the configured sync interval in milliseconds.
   */
  async getSyncInterval(): Promise<number> {
    const custom = await this.env.ADBLOCK_KV.get(KV_KEYS.SYNC_INTERVAL);
    if (custom) {
      const hours = parseFloat(custom);
      if (!isNaN(hours) && hours > 0) return hours * 60 * 60 * 1000;
    }
    return CONFIG.SYNC_INTERVAL_MS;
  }

  // --- ATOMIC WORKFLOW-READY METHODS ---

  /**
   * Atomic Action: Downloads all configured lists and returns the merged domain set.
   */
  async downloadAndDeduplicate(force: boolean = false) {
    const metadataStr = await this.env.ADBLOCK_KV.get(KV_KEYS.METADATA);
    const currentMetadata = metadataStr ? JSON.parse(metadataStr) : {};

    const rawUrls = (await this.env.ADBLOCK_KV.get(KV_KEYS.CUSTOM_URLS)) || this.env.ADBLOCK_LIST_URLS;
    const urls = rawUrls.split(",").map((u) => u.trim()).filter((u) => u);

    const result = await fetchAdBlockList(urls, force ? {} : currentMetadata);
    
    if (result.errors && !result.updated) {
      throw new Error("RSS Fetch failed and no cached update available.");
    }

    if (!result.updated) return { updated: false };

    // Merge blocked and allowed sets
    const { blocked, allowed, metadata } = result;
    if (allowed) {
      for (const domain of allowed) {
        blocked!.delete(domain);
      }
    }

    const finalDomains = Array.from(blocked!);
    return {
      updated: true,
      domains: finalDomains,
      metadata,
      total: finalDomains.length
    };
  }

  /**
   * Atomic Action: Updates a single Gateway list.
   */
  async updateSingleList(name: string, domains: string[], existingId?: string) {
    return await createOrUpdateGatewayList(
      this.env.CLOUDFLARE_ACCOUNT_ID,
      this.env.CLOUDFLARE_API_TOKEN,
      name,
      domains,
      existingId
    );
  }

  /**
   * Atomic Action: Applies the Gateway policy using the provided list IDs.
   */
  async applyFinalPolicy(listIds: string[]) {
    if (!listIds || listIds.length === 0) return;
    await updateGatewayPolicy(
      this.env.CLOUDFLARE_ACCOUNT_ID,
      this.env.CLOUDFLARE_API_TOKEN,
      "Block Ads (Managed by Worker)",
      listIds
    );
  }

  /**
   * Atomic Action: Deletes Gateway lists that are no longer needed.
   */
  async cleanupObsoleteLists(activeChunkCount: number) {
    const allLists = await getGatewayLists(
      this.env.CLOUDFLARE_ACCOUNT_ID,
      this.env.CLOUDFLARE_API_TOKEN
    );
    
    const toDelete = allLists.filter((l) => {
      if (!l.name.startsWith(this.env.LIST_PREFIX)) return false;
      const index = parseInt(l.name.substring(this.env.LIST_PREFIX.length));
      return !isNaN(index) && index > activeChunkCount;
    });

    for (const list of toDelete) {
      await deleteGatewayList(
        this.env.CLOUDFLARE_ACCOUNT_ID,
        this.env.CLOUDFLARE_API_TOKEN,
        list.id
      );
    }
    return toDelete.length;
  }

  // --- LEGACY STATE MACHINE (Maintained for UI compatibility) ---

  async processNextStep(
    force: boolean = false,
    onProgress?: ProgressCallback,
    cachedDomains?: string[],
    existingListsMap?: Record<string, string>,
  ): Promise<SyncStatus> {
    const status = ((await this.env.ADBLOCK_KV.get(KV_KEYS.STATUS)) as SyncStatus) || "IDLE";

    if (onProgress) await onProgress(`📍 Current Phase: <span class="status">${status}</span>`);

    if (status === "IDLE") {
      const lastRun = await this.env.ADBLOCK_KV.get(KV_KEYS.LAST_RUN);
      const intervalMs = await this.getSyncInterval();
      const now = Date.now();

      if (!force && lastRun && now - parseInt(lastRun) < intervalMs) {
        return "IDLE";
      }

      await this.env.ADBLOCK_KV.put(KV_KEYS.STATUS, "DOWNLOADING");
      await this.handleDownloading(force, onProgress);
    } else {
      switch (status) {
        case "DOWNLOADING":
          await this.handleDownloading(force, onProgress);
          break;
        case "UPDATING_LISTS":
          await this.handleUpdatingLists(onProgress, cachedDomains, existingListsMap);
          break;
        case "UPDATING_POLICY":
          await this.handleUpdatingPolicy(onProgress);
          break;
        case "CLEANING_UP":
          await this.handleCleanup(onProgress);
          break;
      }
    }

    return ((await this.env.ADBLOCK_KV.get(KV_KEYS.STATUS)) as SyncStatus) || "IDLE";
  }

  async handleDownloading(forceUpdate: boolean = false, onProgress?: ProgressCallback) {
    await this.updateHeartbeat();
    try {
      const result = await this.downloadAndDeduplicate(forceUpdate);

      if (!result.updated) {
        await this.env.ADBLOCK_KV.put(KV_KEYS.STATUS, "IDLE");
        await this.env.ADBLOCK_KV.put(KV_KEYS.LAST_RUN, Date.now().toString());
        if (onProgress) await onProgress("✅ No changes detected.", "success");
        return;
      }

      await this.env.ADBLOCK_KV.put(KV_KEYS.FULL_LIST, result.domains!.join("\n"));
      await this.env.ADBLOCK_KV.put(KV_KEYS.METADATA, JSON.stringify(result.metadata));
      const maxItems = parseInt(this.env.MAX_ITEMS_PER_LIST) || 1000;
      const totalChunks = Math.ceil(result.total! / maxItems);
      await this.env.ADBLOCK_KV.put(KV_KEYS.CHUNKS_META, JSON.stringify({ total: totalChunks, current: 0 }));
      await this.env.ADBLOCK_KV.put(KV_KEYS.LIST_IDS, JSON.stringify([]));
      await this.env.ADBLOCK_KV.put(KV_KEYS.STATUS, "UPDATING_LISTS");

      if (onProgress) await onProgress(`✔️ Download complete. ${result.total} domains.`, "info");
    } catch (e: any) {
      if (onProgress) await onProgress(`❌ Error: ${e.message}`, "error");
    }
  }

  async handleUpdatingLists(onProgress?: ProgressCallback, cachedDomains?: string[], existingMap?: Record<string, string>) {
    await this.updateHeartbeat();
    const metaStr = await this.env.ADBLOCK_KV.get(KV_KEYS.CHUNKS_META);
    if (!metaStr) return;

    const meta = JSON.parse(metaStr) as ChunksMeta;
    const listIdsStr = await this.env.ADBLOCK_KV.get(KV_KEYS.LIST_IDS);
    const listIds: string[] = listIdsStr ? JSON.parse(listIdsStr) : [];

    let allDomains: string[] = [];
    if (cachedDomains) allDomains = cachedDomains;
    else {
      const fullListStr = await this.env.ADBLOCK_KV.get(KV_KEYS.FULL_LIST);
      if (!fullListStr) return;
      allDomains = fullListStr.split("\n");
    }

    const maxItems = parseInt(this.env.MAX_ITEMS_PER_LIST) || 1000;
    const maxLists = parseInt(this.env.MAX_LISTS) || 90;
    let processedCount = 0;

    let map = existingMap;
    if (!map) {
      const lists = await getGatewayLists(this.env.CLOUDFLARE_ACCOUNT_ID, this.env.CLOUDFLARE_API_TOKEN);
      map = {};
      lists.forEach((l: any) => (map![l.name] = l.id));
    }

    while (processedCount < CONFIG.BATCH_SIZE && meta.current < meta.total) {
      if (meta.current >= maxLists) break;
      const chunkIndex = meta.current;
      const chunkItems = allDomains.slice(chunkIndex * maxItems, (chunkIndex + 1) * maxItems);
      const listName = `${this.env.LIST_PREFIX}${chunkIndex + 1}`;

      const id = await this.updateSingleList(listName, chunkItems, map[listName]);
      if (id && !listIds.includes(id)) listIds.push(id);
      
      meta.current++;
      processedCount++;
    }

    await this.env.ADBLOCK_KV.put(KV_KEYS.CHUNKS_META, JSON.stringify(meta));
    await this.env.ADBLOCK_KV.put(KV_KEYS.LIST_IDS, JSON.stringify(listIds));

    if (onProgress) await onProgress(`📊 Progress: ${meta.current}/${meta.total}`, "meta", meta);

    if (meta.current >= meta.total || meta.current >= maxLists) {
      await this.env.ADBLOCK_KV.put(KV_KEYS.STATUS, "UPDATING_POLICY");
    }
  }

  async handleUpdatingPolicy(onProgress?: ProgressCallback) {
    await this.updateHeartbeat();
    const listIdsStr = await this.env.ADBLOCK_KV.get(KV_KEYS.LIST_IDS);
    const listIds: string[] = listIdsStr ? JSON.parse(listIdsStr) : [];

    if (listIds.length > 0) {
      await this.applyFinalPolicy(listIds);
      if (onProgress) await onProgress("✔️ Policy updated.", "success");
    }
    await this.env.ADBLOCK_KV.put(KV_KEYS.STATUS, "CLEANING_UP");
  }

  async handleCleanup(onProgress?: ProgressCallback) {
    await this.updateHeartbeat();
    const metaStr = await this.env.ADBLOCK_KV.get(KV_KEYS.CHUNKS_META);
    if (!metaStr) return;
    
    const meta = JSON.parse(metaStr) as ChunksMeta;
    const deleted = await this.cleanupObsoleteLists(meta.total);
    
    await this.env.ADBLOCK_KV.put(KV_KEYS.STATUS, "IDLE");
    await this.env.ADBLOCK_KV.put(KV_KEYS.LAST_RUN, Date.now().toString());
    await this.clearHeartbeat();
    if (onProgress) await onProgress(`✨ Cycle Complete. Deleted ${deleted} lists.`, "success");
  }

  async resetState() {
    await this.env.ADBLOCK_KV.put(KV_KEYS.STATUS, "IDLE");
    await Promise.all([
      this.env.ADBLOCK_KV.delete(KV_KEYS.CHUNKS_META),
      this.env.ADBLOCK_KV.delete(KV_KEYS.LIST_IDS),
      this.env.ADBLOCK_KV.delete(KV_KEYS.LAST_RUN),
      this.env.ADBLOCK_KV.delete(KV_KEYS.METADATA),
      this.env.ADBLOCK_KV.delete(KV_KEYS.HEARTBEAT),
      this.env.ADBLOCK_KV.delete(KV_KEYS.FULL_LIST),
    ]);
  }
}
