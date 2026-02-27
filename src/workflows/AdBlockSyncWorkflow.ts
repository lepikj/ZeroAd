import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { Bindings, KV_KEYS } from "../types";
import { SyncEngine } from "../engine";
import { getGatewayLists } from "../api";

interface SyncEvent {
  force?: boolean;
}

/**
 * AdBlockSyncWorkflow
 * Orchestrates the adblock list synchronization process using discrete, durable steps.
 */
export class AdBlockSyncWorkflow extends WorkflowEntrypoint<Bindings> {
  async run(event: WorkflowEvent<SyncEvent>, step: WorkflowStep) {
    const batchTimestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const runId = event.instanceId || crypto.randomUUID();
    const runPrefix = `sync/runs/${runId}/`;
    const force = event.payload?.force || false;
    
    const engine = new SyncEngine(this.env);

    // 1. MAP: Download and split into R2 parts
    const mapResult = await step.do('download-and-partition', async () => {
      console.log(`[workflow] Starting download (force=${force})`);
      const result = await engine.downloadAndDeduplicate(force);

      if (!result.updated) {
        console.log("[workflow] No changes detected. Exiting.");
        return { updated: false };
      }

      const maxItems = parseInt(this.env.MAX_ITEMS_PER_LIST) || 1000;
      const domains = result.domains!;
      const totalChunks = Math.ceil(domains.length / maxItems);
      const partKeys: string[] = [];

      for (let i = 0; i < totalChunks; i++) {
        const chunk = domains.slice(i * maxItems, (i + 1) * maxItems);
        const key = `${runPrefix}parts/${i}.json`;
        await this.env.SYNC_BUCKET.put(key, JSON.stringify(chunk));
        partKeys.push(key);
      }

      console.log(`[workflow] Split into ${totalChunks} parts in R2`);
      return { 
        updated: true, 
        partKeys, 
        metadata: result.metadata, 
        totalDomains: result.total 
      };
    });

    if (!mapResult.updated) {
      await step.do('finalize-idle', async () => {
        await this.env.ADBLOCK_KV.put(KV_KEYS.STATUS, "IDLE");
        await this.env.ADBLOCK_KV.put(KV_KEYS.LAST_RUN, Date.now().toString());
      });
      return;
    }

    // 2. REDUCE: Update each Gateway list in its own step
    const listIds: string[] = [];
    
    // Optimization: Fetch existing lists once to map names to IDs
    const existingMap = await step.do('fetch-existing-lists', async () => {
      const lists = await getGatewayLists(this.env.CLOUDFLARE_ACCOUNT_ID, this.env.CLOUDFLARE_API_TOKEN);
      const map: Record<string, string> = {};
      lists.forEach(l => map[l.name] = l.id);
      return map;
    });

    for (let i = 0; i < mapResult.partKeys!.length; i++) {
      const partKey = mapResult.partKeys![i];
      const listName = `${this.env.LIST_PREFIX}${i + 1}`;
      
      const listId = await step.do(`update-list-${i + 1}`, async () => {
        const obj = await this.env.SYNC_BUCKET.get(partKey);
        if (!obj) throw new Error(`Part missing from R2: ${partKey}`);
        
        const chunkDomains = await obj.json() as string[];
        const id = await engine.updateSingleList(listName, chunkDomains, existingMap[listName]);
        if (!id) throw new Error(`Failed to update Gateway list: ${listName}`);
        
        return id;
      });
      
      listIds.push(listId);
    }

    // 3. APPLY: Update Policy
    await step.do('apply-policy', async () => {
      console.log(`[workflow] Applying policy with ${listIds.length} lists`);
      await engine.applyFinalPolicy(listIds);
    });

    // 4. CLEANUP: Clear R2 and old lists
    await step.do('cleanup-final', async () => {
      console.log("[workflow] Finalizing and cleaning up...");
      
      // Delete obsolete Gateway lists
      const deletedLists = await engine.cleanupObsoleteLists(listIds.length);
      
      // Update persistent state
      await this.env.ADBLOCK_KV.put(KV_KEYS.STATUS, "IDLE");
      await this.env.ADBLOCK_KV.put(KV_KEYS.LAST_RUN, Date.now().toString());
      await this.env.ADBLOCK_KV.put(KV_KEYS.METADATA, JSON.stringify(mapResult.metadata));

      // Cleanup R2 for this run
      const listR2 = await this.env.SYNC_BUCKET.list({ prefix: runPrefix });
      const keysToDelete = listR2.objects.map(obj => obj.key);
      if (keysToDelete.length > 0) {
        await (this.env.SYNC_BUCKET as any).delete(keysToDelete).catch(() => {
           // Fallback for environments where bulk delete isn't exposed correctly
           return Promise.all(keysToDelete.map(k => this.env.SYNC_BUCKET.delete(k)));
        });
      }

      console.log(`[workflow] Sync complete. ${mapResult.totalDomains} domains, ${deletedLists} old lists removed.`);
    });
  }
}
