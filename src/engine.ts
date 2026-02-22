/**
 * ZeroAd: Sync Engine (Core Logic & State Machine)
 */

import {
  Bindings,
  SyncStatus,
  KV_KEYS,
  CONFIG,
  ChunksMeta,
} from "./types";
import {
  getGatewayLists,
  createOrUpdateGatewayList,
  updateGatewayPolicy,
  deleteGatewayList,
} from "./api";
import { fetchAdBlockList } from "./parser";

export type ProgressCallback = (msg: string, type?: string, meta?: any) => Promise<void>;

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
   * Orchestrates the next step in the sync cycle.
   */
  async processNextStep(
    force: boolean = false, 
    onProgress?: ProgressCallback,
    cachedDomains?: string[],
    existingListsMap?: Record<string, string>
  ): Promise<SyncStatus> {
    const status = (await this.env.ADBLOCK_KV.get(KV_KEYS.STATUS)) as SyncStatus || "IDLE";
    
    // Log start of step if callback provided
    if (onProgress) {
      await onProgress(`📍 Current Phase: <span class="status">${status}</span>`);
    }

    switch (status) {
      case "IDLE":
        if (onProgress) await onProgress(`🆕 IDLE -> Starting new cycle.`, "info");
        await this.env.ADBLOCK_KV.put(KV_KEYS.STATUS, "DOWNLOADING");
        await this.handleDownloading(force, onProgress);
        break;
      case "DOWNLOADING":
        await this.handleDownloading(force, onProgress);
        break;
      case "UPDATING_LISTS":
        let map = existingListsMap;
        if (!map) {
          if (onProgress) await onProgress(`📡 Pre-fetching Gateway lists...`, "meta");
          const lists = await getGatewayLists(this.env.CLOUDFLARE_ACCOUNT_ID, this.env.CLOUDFLARE_API_TOKEN);
          map = {};
          lists.forEach((l: any) => (map![l.name] = l.id));
        }
        await this.handleUpdatingLists(onProgress, cachedDomains, map);
        break;
      case "UPDATING_POLICY":
        await this.handleUpdatingPolicy(onProgress);
        break;
      case "CLEANING_UP":
        await this.handleCleanup(onProgress);
        break;
    }

    return (await this.env.ADBLOCK_KV.get(KV_KEYS.STATUS)) as SyncStatus || "IDLE";
  }

  /**
   * Phase 1: Download and Parse
   */
  async handleDownloading(
    forceUpdate: boolean = false,
    onProgress?: ProgressCallback,
  ) {
    const startTime = Date.now();
    await this.updateHeartbeat();
    const msg = `📥 Downloading and checking lists...`;
    if (onProgress) await onProgress(msg, "info");
    console.log(msg);

    try {
      const metadataStr = await this.env.ADBLOCK_KV.get(KV_KEYS.METADATA);
      const currentMetadata = metadataStr ? JSON.parse(metadataStr) : {};

      const rawUrls =
        (await this.env.ADBLOCK_KV.get(KV_KEYS.CUSTOM_URLS)) ||
        this.env.ADBLOCK_LIST_URLS;
      const urls = rawUrls
        .split(",")
        .map((u) => u.trim())
        .filter((u) => u);

      const result = await fetchAdBlockList(
        urls,
        forceUpdate ? {} : currentMetadata,
      );

      if (!result.updated) {
        const skipMsg = `✅ No changes detected. Skipping cycle.`;
        if (onProgress) await onProgress(skipMsg, "success");
        console.log(skipMsg);
        await this.env.ADBLOCK_KV.put(KV_KEYS.STATUS, "IDLE");
        await this.env.ADBLOCK_KV.put(KV_KEYS.LAST_RUN, Date.now().toString());
        return;
      }

      const { blocked, allowed, metadata } = result;
      for (const domain of allowed!) {
        blocked!.delete(domain);
      }

      const finalDomains = Array.from(blocked!);
      const maxItems = parseInt(this.env.MAX_ITEMS_PER_LIST) || 1000;
      const totalChunks = Math.ceil(finalDomains.length / maxItems);

      await this.env.ADBLOCK_KV.put(KV_KEYS.FULL_LIST, finalDomains.join("\n"));
      await this.env.ADBLOCK_KV.put(KV_KEYS.METADATA, JSON.stringify(metadata));
      await this.env.ADBLOCK_KV.put(
        KV_KEYS.CHUNKS_META,
        JSON.stringify({ total: totalChunks, current: 0 }),
      );
      await this.env.ADBLOCK_KV.put(KV_KEYS.LIST_IDS, JSON.stringify([]));
      await this.env.ADBLOCK_KV.put(KV_KEYS.STATUS, "UPDATING_LISTS");

      const doneMsg = `✔️ Download complete. Processed ${finalDomains.length} domains into ${totalChunks} chunks (${Date.now() - startTime}ms).`;
      if (onProgress) await onProgress(doneMsg, "info");
      console.log(doneMsg);
    } catch (e: any) {
      const errMsg = `❌ Download failed: ${e.message}`;
      if (onProgress) await onProgress(errMsg, "error");
      console.error(errMsg);
    }
  }

  /**
   * Phase 2: Update Lists
   */
  async handleUpdatingLists(
    onProgress?: ProgressCallback,
    cachedDomains?: string[],
    existingListsMap?: Record<string, string>,
  ) {
    const startTime = Date.now();
    await this.updateHeartbeat();

    const metaStr = await this.env.ADBLOCK_KV.get(KV_KEYS.CHUNKS_META);
    if (!metaStr) {
      await this.env.ADBLOCK_KV.put(KV_KEYS.STATUS, "IDLE");
      return;
    }

    const meta = JSON.parse(metaStr) as ChunksMeta;
    const listIdsStr = await this.env.ADBLOCK_KV.get(KV_KEYS.LIST_IDS);
    const listIds: string[] = listIdsStr ? JSON.parse(listIdsStr) : [];

    let allDomains: string[] = [];
    if (cachedDomains) {
      allDomains = cachedDomains;
    } else {
      const fullListStr = await this.env.ADBLOCK_KV.get(KV_KEYS.FULL_LIST);
      if (!fullListStr) {
        await this.env.ADBLOCK_KV.put(KV_KEYS.STATUS, "DOWNLOADING");
        return;
      }
      allDomains = fullListStr.split("\n");
    }

    const maxItems = parseInt(this.env.MAX_ITEMS_PER_LIST) || 1000;
    const maxLists = parseInt(this.env.MAX_LISTS) || 90;
    let processedCount = 0;

    const startMsg = `🔄 Updating lists batch (Starting at ${meta.current})...`;
    if (onProgress) await onProgress(startMsg, "info");
    console.log(startMsg);

    while (processedCount < CONFIG.BATCH_SIZE && meta.current < meta.total) {
      if (meta.current >= maxLists) break;

      const chunkIndex = meta.current;
      const chunkItems = allDomains.slice(
        chunkIndex * maxItems,
        (chunkIndex + 1) * maxItems,
      );
      const listName = `${this.env.LIST_PREFIX}${chunkIndex + 1}`;

      try {
        const existingId = existingListsMap
          ? existingListsMap[listName]
          : undefined;
        const id = await createOrUpdateGatewayList(
          this.env.CLOUDFLARE_ACCOUNT_ID,
          this.env.CLOUDFLARE_API_TOKEN,
          listName,
          chunkItems,
          existingId,
        );
        if (id && !listIds.includes(id)) listIds.push(id);
      } catch (e: any) {
        if (onProgress)
          await onProgress(`⚠️ Failed to update ${listName}: ${e.message}`, "warn");
        console.error(`Failed to update list ${listName}: ${e.message}`);
      }

      meta.current++;
      processedCount++;
    }

    await this.env.ADBLOCK_KV.put(KV_KEYS.CHUNKS_META, JSON.stringify(meta));
    await this.env.ADBLOCK_KV.put(KV_KEYS.LIST_IDS, JSON.stringify(listIds));

    const progressMsg = `📊 Progress: ${meta.current}/${meta.total} lists updated (${Date.now() - startTime}ms).`;
    if (onProgress) {
      await onProgress(progressMsg, "meta", meta);
    }
    console.log(progressMsg);

    if (meta.current >= meta.total || meta.current >= maxLists) {
      await this.env.ADBLOCK_KV.put(KV_KEYS.STATUS, "UPDATING_POLICY");
    }
  }

  /**
   * Phase 3: Apply Policy
   */
  async handleUpdatingPolicy(onProgress?: ProgressCallback) {
    const startTime = Date.now();
    await this.updateHeartbeat();
    const startMsg = `🛡️ Updating Gateway Policy...`;
    if (onProgress) await onProgress(startMsg, "info");
    console.log(startMsg);

    const listIdsStr = await this.env.ADBLOCK_KV.get(KV_KEYS.LIST_IDS);
    const listIds: string[] = listIdsStr ? JSON.parse(listIdsStr) : [];

    if (listIds.length > 0) {
      try {
        await updateGatewayPolicy(
          this.env.CLOUDFLARE_ACCOUNT_ID,
          this.env.CLOUDFLARE_API_TOKEN,
          "Block Ads (Managed by Worker)",
          listIds,
        );
        const okMsg = `✔️ Policy updated successfully (${Date.now() - startTime}ms).`;
        if (onProgress) await onProgress(okMsg, "success");
        console.log(okMsg);
      } catch (e: any) {
        const errMsg = `❌ Policy update failed: ${e.message}`;
        if (onProgress) await onProgress(errMsg, "error");
        console.error(errMsg);
      }
    }
    await this.env.ADBLOCK_KV.put(KV_KEYS.STATUS, "CLEANING_UP");
  }

  /**
   * Phase 4: Cleanup
   */
  async handleCleanup(onProgress?: ProgressCallback) {
    const startTime = Date.now();
    await this.updateHeartbeat();
    const startMsg = `🧹 Cleaning up old lists...`;
    if (onProgress) await onProgress(startMsg, "info");
    console.log(startMsg);

    // Give Cloudflare a moment to propagate the policy update and release the lists
    await new Promise((r) => setTimeout(r, 2000));

    const metaStr = await this.env.ADBLOCK_KV.get(KV_KEYS.CHUNKS_META);
    let deletedCount = 0;
    if (metaStr) {
      const meta = JSON.parse(metaStr) as ChunksMeta;
      const allLists = await getGatewayLists(
        this.env.CLOUDFLARE_ACCOUNT_ID,
        this.env.CLOUDFLARE_API_TOKEN,
      );
      const toDelete = allLists.filter((l) => {
        if (!l.name.startsWith(this.env.LIST_PREFIX)) return false;
        const index = parseInt(l.name.substring(this.env.LIST_PREFIX.length));
        return !isNaN(index) && index > meta.total;
      });

      console.log(`Found ${toDelete.length} old lists to delete.`);

      // Delete in small batches to stay under subrequest limits
      for (let i = 0; i < toDelete.length; i++) {
        const list = toDelete[i];
        const delMsg = `🗑️ Deleting legacy list: ${list.name} (${i + 1}/${toDelete.length})`;
        if (onProgress) await onProgress(delMsg, "meta");
        console.log(delMsg);
        
        await deleteGatewayList(
          this.env.CLOUDFLARE_ACCOUNT_ID,
          this.env.CLOUDFLARE_API_TOKEN,
          list.id,
        );
        deletedCount++;

        // Every 5 deletes, update heartbeat and check subrequest risk
        if (deletedCount % 5 === 0) await this.updateHeartbeat();
      }
    }

    await this.env.ADBLOCK_KV.put(KV_KEYS.STATUS, "IDLE");
    await this.env.ADBLOCK_KV.put(KV_KEYS.LAST_RUN, Date.now().toString());
    await this.clearHeartbeat();

    const doneMsg = `✨ Cycle Complete! All synchronized. Deleted ${deletedCount} legacy lists (${Date.now() - startTime}ms).`;
    if (onProgress) await onProgress(doneMsg, "success");
    console.log(doneMsg);
  }

  /**
   * Resets the engine state.
   */
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