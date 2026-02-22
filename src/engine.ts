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
  async processNextStep(force: boolean = false): Promise<SyncStatus> {
    const status = (await this.env.ADBLOCK_KV.get(KV_KEYS.STATUS)) as SyncStatus || "IDLE";

    switch (status) {
      case "IDLE":
        await this.env.ADBLOCK_KV.put(KV_KEYS.STATUS, "DOWNLOADING");
        await this.handleDownloading(force);
        break;
      case "DOWNLOADING":
        await this.handleDownloading(force);
        break;
      case "UPDATING_LISTS":
        const lists = await getGatewayLists(this.env.CLOUDFLARE_ACCOUNT_ID, this.env.CLOUDFLARE_API_TOKEN);
        const existingMap: Record<string, string> = {};
        lists.forEach((l: any) => (existingMap[l.name] = l.id));
        await this.handleUpdatingLists(undefined, existingMap);
        break;
      case "UPDATING_POLICY":
        await this.handleUpdatingPolicy();
        break;
      case "CLEANING_UP":
        await this.handleCleanup();
        break;
    }

    return (await this.env.ADBLOCK_KV.get(KV_KEYS.STATUS)) as SyncStatus || "IDLE";
  }

  /**
   * Phase 1: Download and Parse
   */
  async handleDownloading(forceUpdate: boolean = false) {
    await this.updateHeartbeat();
    console.log("Checking for source list changes...");

    try {
      const metadataStr = await this.env.ADBLOCK_KV.get(KV_KEYS.METADATA);
      const currentMetadata = metadataStr ? JSON.parse(metadataStr) : {};

      const rawUrls = (await this.env.ADBLOCK_KV.get(KV_KEYS.CUSTOM_URLS)) || this.env.ADBLOCK_LIST_URLS;
      const urls = rawUrls.split(",").map((u) => u.trim()).filter((u) => u);

      const result = await fetchAdBlockList(urls, forceUpdate ? {} : currentMetadata);

      if (!result.updated) {
        console.log("No changes detected.");
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
      await this.env.ADBLOCK_KV.put(KV_KEYS.CHUNKS_META, JSON.stringify({ total: totalChunks, current: 0 }));
      await this.env.ADBLOCK_KV.put(KV_KEYS.LIST_IDS, JSON.stringify([]));
      await this.env.ADBLOCK_KV.put(KV_KEYS.STATUS, "UPDATING_LISTS");

      console.log("Download complete. Moving to UPDATING_LISTS.");
    } catch (e: any) {
      console.error(`Download failed: ${e.message}`);
    }
  }

  /**
   * Phase 2: Update Lists
   */
  async handleUpdatingLists(cachedDomains?: string[], existingListsMap?: Record<string, string>) {
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

    while (processedCount < CONFIG.BATCH_SIZE && meta.current < meta.total) {
      if (meta.current >= maxLists) break;

      const chunkIndex = meta.current;
      const chunkItems = allDomains.slice(chunkIndex * maxItems, (chunkIndex + 1) * maxItems);
      const listName = `${this.env.LIST_PREFIX}${chunkIndex + 1}`;

      try {
        const existingId = existingListsMap ? existingListsMap[listName] : undefined;
        const id = await createOrUpdateGatewayList(this.env.CLOUDFLARE_ACCOUNT_ID, this.env.CLOUDFLARE_API_TOKEN, listName, chunkItems, existingId);
        if (id && !listIds.includes(id)) listIds.push(id);
      } catch (e: any) {
        console.error(`Failed to update list ${listName}: ${e.message}`);
      }

      meta.current++;
      processedCount++;
    }

    await this.env.ADBLOCK_KV.put(KV_KEYS.CHUNKS_META, JSON.stringify(meta));
    await this.env.ADBLOCK_KV.put(KV_KEYS.LIST_IDS, JSON.stringify(listIds));

    if (meta.current >= meta.total || meta.current >= maxLists) {
      await this.env.ADBLOCK_KV.put(KV_KEYS.STATUS, "UPDATING_POLICY");
    }
  }

  /**
   * Phase 3: Apply Policy
   */
  async handleUpdatingPolicy() {
    await this.updateHeartbeat();
    const listIdsStr = await this.env.ADBLOCK_KV.get(KV_KEYS.LIST_IDS);
    const listIds: string[] = listIdsStr ? JSON.parse(listIdsStr) : [];

    if (listIds.length > 0) {
      try {
        await updateGatewayPolicy(this.env.CLOUDFLARE_ACCOUNT_ID, this.env.CLOUDFLARE_API_TOKEN, "Block Ads (Managed by Worker)", listIds);
      } catch (e: any) {
        console.error(`Policy update failed: ${e.message}`);
      }
    }
    await this.env.ADBLOCK_KV.put(KV_KEYS.STATUS, "CLEANING_UP");
  }

  /**
   * Phase 4: Cleanup
   */
  async handleCleanup() {
    await this.updateHeartbeat();
    const metaStr = await this.env.ADBLOCK_KV.get(KV_KEYS.CHUNKS_META);
    if (metaStr) {
      const meta = JSON.parse(metaStr) as ChunksMeta;
      const allLists = await getGatewayLists(this.env.CLOUDFLARE_ACCOUNT_ID, this.env.CLOUDFLARE_API_TOKEN);
      const toDelete = allLists.filter((l) => {
        if (!l.name.startsWith(this.env.LIST_PREFIX)) return false;
        const index = parseInt(l.name.substring(this.env.LIST_PREFIX.length));
        return !isNaN(index) && index > meta.total;
      });

      for (const list of toDelete) {
        await deleteGatewayList(this.env.CLOUDFLARE_ACCOUNT_ID, this.env.CLOUDFLARE_API_TOKEN, list.id);
      }
    }

    await this.env.ADBLOCK_KV.put(KV_KEYS.STATUS, "IDLE");
    await this.env.ADBLOCK_KV.put(KV_KEYS.LAST_RUN, Date.now().toString());
    await this.clearHeartbeat();
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
