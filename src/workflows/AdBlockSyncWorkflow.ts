import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { Bindings, KV_KEYS } from "../types";
import { SyncEngine } from "../engine";
import { getGatewayLists } from "../api";

interface SyncEvent {
  force?: boolean;
}

/**
 * AdBlockSyncWorkflow (Queue-Powered Edition)
 * Orchestrates the full adblock list synchronization.
 * Offloads subrequest-heavy list updates to Cloudflare Queues to stay under Free Plan limits.
 */
export class AdBlockSyncWorkflow extends WorkflowEntrypoint<Bindings> {
  async run(event: WorkflowEvent<SyncEvent>, step: WorkflowStep) {
    const runId = event.instanceId || crypto.randomUUID();
    const runPrefix = `sync/runs/${runId}/`;
    const force = (event as any).payload?.force || false;
    
    const engine = new SyncEngine(this.env);

    // 1. DOWNLOAD & PARTITION
    const mapResult = await step.do('download-and-partition', async () => {
      await engine.reportWorkflowProgress(runId, "DOWNLOADING");
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
        totalChunks, 
        partKeys,
        metadata: result.metadata, 
        totalDomains: result.total 
      };
    });

    if (!mapResult.updated) {
      await step.do('finalize-idle', async () => {
        await this.env.ADBLOCK_KV.put(KV_KEYS.STATUS, "IDLE");
        await this.env.ADBLOCK_KV.put(KV_KEYS.LAST_RUN, Date.now().toString());
        await engine.reportWorkflowProgress(runId, "IDLE");
      });
      return;
    }

    // 2. DISPATCH TO QUEUE
    await step.do('dispatch-tasks', async () => {
      await engine.reportWorkflowProgress(runId, "DISPATCHING", 0, mapResult.totalChunks);
      
      // Fetch existing mapping once to help the queue workers
      const lists = await getGatewayLists(this.env.CLOUDFLARE_ACCOUNT_ID, this.env.CLOUDFLARE_API_TOKEN);
      const existingMap: Record<string, string> = {};
      lists.forEach(l => existingMap[l.name] = l.id);

      const messages = [];
      for (let i = 0; i < mapResult.totalChunks!; i++) {
        const listName = `${this.env.LIST_PREFIX}${i + 1}`;
        messages.push({
          contentType: 'json',
          body: {
            runId,
            listName,
            r2Key: mapResult.partKeys![i],
            existingId: existingMap[listName]
          }
        });
      }

      // Send in batches of 100 (Max allowed by sendBatch)
      for (let i = 0; i < messages.length; i += 100) {
        const batch = messages.slice(i, i + 100);
        await (this.env.SYNC_QUEUE as any).sendBatch(batch);
      }

      console.log(`[workflow] Dispatched ${messages.length} tasks to SYNC_QUEUE`);
    });

    // 3. WAIT FOR COMPLETION
    // We poll KV to see if the queue workers have finished their 1000 subrequest-heavy tasks.
    await step.do('wait-for-queue', async () => {
      const prefix = `${KV_KEYS.LIST_IDS}_${runId}_`;
      let completed = 0;
      const total = mapResult.totalChunks!;
      
      // Safety: Max 60 polls (approx 60 mins)
      for (let attempt = 0; attempt < 60; attempt++) {
        const list = await this.env.ADBLOCK_KV.list({ prefix });
        completed = list.keys.length;
        
        await engine.reportWorkflowProgress(runId, "PROCESSING_QUEUE", completed, total);
        console.log(`[workflow] Progress: ${completed}/${total} lists updated (Attempt ${attempt + 1})`);

        if (completed >= total) break;
        
        // Wait 1 minute before next poll
        await new Promise(r => setTimeout(r, 60000));
      }

      if (completed < total) {
        throw new Error(`Queue processing timed out. Only ${completed}/${total} done.`);
      }
    });

    // 4. AGGREGATE IDS & APPLY POLICY
    const finalIds = await step.do('apply-policy', async () => {
      await engine.reportWorkflowProgress(runId, "APPLYING_POLICY");
      
      const ids: string[] = [];
      for (let i = 0; i < mapResult.totalChunks!; i++) {
        const listName = `${this.env.LIST_PREFIX}${i + 1}`;
        const id = await this.env.ADBLOCK_KV.get(`${KV_KEYS.LIST_IDS}_${runId}_${listName}`);
        if (id) ids.push(id);
      }

      console.log(`[workflow] Applying policy with ${ids.length} lists`);
      await engine.applyFinalPolicy(ids);
      return ids;
    });

    // 5. CLEANUP
    await step.do('cleanup-final', async () => {
      await engine.reportWorkflowProgress(runId, "CLEANING_UP");
      
      // Delete obsolete Gateway lists
      const deletedLists = await engine.performCleanup(mapResult.totalChunks!);
      
      // Update persistent state
      await this.env.ADBLOCK_KV.put(KV_KEYS.STATUS, "IDLE");
      await this.env.ADBLOCK_KV.put(KV_KEYS.LAST_RUN, Date.now().toString());
      await this.env.ADBLOCK_KV.put(KV_KEYS.METADATA, JSON.stringify(mapResult.metadata));

      // Cleanup R2 and Run-specific KV keys
      const listR2 = await this.env.SYNC_BUCKET.list({ prefix: runPrefix });
      const keysToDelete = listR2.objects.map(obj => obj.key);
      if (keysToDelete.length > 0) {
        await (this.env.SYNC_BUCKET as any).delete(keysToDelete).catch(() => {
           return Promise.all(keysToDelete.map(k => this.env.SYNC_BUCKET.delete(k)));
        });
      }

      // Cleanup temporary KV keys used for this run
      await this.env.ADBLOCK_KV.delete(`sync_count_${runId}`);
      for (let i = 0; i < mapResult.totalChunks!; i++) {
        const listName = `${this.env.LIST_PREFIX}${i + 1}`;
        await this.env.ADBLOCK_KV.delete(`${KV_KEYS.LIST_IDS}_${runId}_${listName}`);
      }

      await engine.reportWorkflowProgress(runId, "IDLE");
      console.log(`[workflow] Sync complete. ${mapResult.totalDomains} domains, ${deletedLists} old lists removed.`);
    });
  }
}
