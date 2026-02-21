import { Bindings, fetchAdBlockList, getGatewayLists, createOrUpdateGatewayList, updateGatewayPolicy } from './api';

const KV_KEY_STATUS = 'status';
const KV_KEY_CHUNKS_META = 'chunks_meta';
const KV_KEY_LIST_IDS = 'list_ids';
const KV_KEY_LAST_RUN = 'last_run';
const CHUNK_PREFIX = 'chunk_';

const BATCH_SIZE = 5; // Process 5 lists per cron execution to be safe

const KV_KEY_METADATA = 'source_metadata';

async function handleDownloading(env: Bindings, forceUpdate: boolean = false) {
  console.log('Checking for source list changes...');
  try {
    const metadataStr = await env.ADBLOCK_KV.get(KV_KEY_METADATA);
    const currentMetadata = metadataStr ? JSON.parse(metadataStr) : {};

    const urls = env.ADBLOCK_LIST_URLS.split(',').map(u => u.trim()).filter(u => u);
    
    // Pass metadata to skip if headers match, unless forced
    const result = await fetchAdBlockList(urls, forceUpdate ? {} : currentMetadata);

    if (!result.updated) {
      console.log('No changes detected in source lists. Skipping update cycle.');
      await env.ADBLOCK_KV.put(KV_KEY_STATUS, 'IDLE');
      await env.ADBLOCK_KV.put(KV_KEY_LAST_RUN, Date.now().toString());
      return;
    }

    const { blocked, allowed, metadata } = result;
    console.log(`Changes detected. Processing ${blocked!.size} blocked domains and ${allowed!.size} allowed domains.`);
    
    // Apply whitelisting: remove allowed domains from blocked set
    for (const domain of allowed!) {
      blocked!.delete(domain);
    }
    
    const finalDomains = Array.from(blocked!);
    console.log(`Final list size after whitelisting: ${finalDomains.length}`);
    
    const maxItems = parseInt(env.MAX_ITEMS_PER_LIST) || 1000;
    const totalChunks = Math.ceil(finalDomains.length / maxItems);
    
    const fullListStr = finalDomains.join('\n');
    await env.ADBLOCK_KV.put('FULL_LIST', fullListStr);
    
    await env.ADBLOCK_KV.put(KV_KEY_METADATA, JSON.stringify(metadata));
    await env.ADBLOCK_KV.put(KV_KEY_CHUNKS_META, JSON.stringify({
      total: totalChunks,
      current: 0
    }));
    await env.ADBLOCK_KV.put(KV_KEY_LIST_IDS, JSON.stringify([])); // Reset list IDs
    await env.ADBLOCK_KV.put(KV_KEY_STATUS, 'UPDATING_LISTS');
    console.log('Download complete. Saved FULL_LIST. Moving to UPDATING_LISTS.');
    
  } catch (e: any) {
    console.error(`Download failed: ${e.message}`);
    // Retry next time
  }
}

async function handleUpdatingLists(env: Bindings, cachedDomains?: string[], existingListsMap?: Record<string, string>) {
  const metaStr = await env.ADBLOCK_KV.get(KV_KEY_CHUNKS_META);
  if (!metaStr) {
    // Error state, reset
    await env.ADBLOCK_KV.put(KV_KEY_STATUS, 'IDLE');
    return;
  }
  
  let meta = JSON.parse(metaStr);
  let listIdsStr = await env.ADBLOCK_KV.get(KV_KEY_LIST_IDS);
  let listIds: string[] = listIdsStr ? JSON.parse(listIdsStr) : [];
  
  let allDomains: string[] = [];
  if (cachedDomains) {
      allDomains = cachedDomains;
  } else {
      // Read FULL list
      const fullListStr = await env.ADBLOCK_KV.get('FULL_LIST');
      if (!fullListStr) {
          console.error("FULL_LIST missing");
          await env.ADBLOCK_KV.put(KV_KEY_STATUS, 'DOWNLOADING'); // Restart
          return;
      }
      allDomains = fullListStr.split('\n');
  }

  const maxItems = parseInt(env.MAX_ITEMS_PER_LIST) || 1000;
  const maxLists = parseInt(env.MAX_LISTS) || 50;

  let processedCount = 0;
  
  // Process a batch
  while (processedCount < BATCH_SIZE && meta.current < meta.total) {
    // Check if we exceeded max lists limit
    if (meta.current >= maxLists) {
      console.warn(`Reached max lists limit (${maxLists}). Stop creating new lists.`);
      break; 
    }

    const chunkIndex = meta.current;
    const start = chunkIndex * maxItems;
    const end = start + maxItems;
    const chunkItems = allDomains.slice(start, end);
    
    const listName = `${env.LIST_PREFIX}${chunkIndex + 1}`;
    console.log(`Updating list ${listName} (${chunkItems.length} items)...`);
    
    try {
      // Use the provided map if available to skip existence check subrequest
      const existingId = existingListsMap ? existingListsMap[listName] : undefined;

      const id = await createOrUpdateGatewayList(
        env.CLOUDFLARE_ACCOUNT_ID,
        env.CLOUDFLARE_API_TOKEN,
        listName,
        chunkItems,
        existingId
      );
      
      if (id) {
          // Add to IDs if not already there
          if (!listIds.includes(id)) {
            listIds.push(id);
          }
      }
    } catch (e: any) {
      console.error(`Failed to update list ${listName}: ${e.message}`);
    }

    meta.current++;
    processedCount++;
  }

  // Save state
  await env.ADBLOCK_KV.put(KV_KEY_CHUNKS_META, JSON.stringify(meta));
  await env.ADBLOCK_KV.put(KV_KEY_LIST_IDS, JSON.stringify(listIds));

  if (meta.current >= meta.total || meta.current >= maxLists) {
    console.log('All lists updated. Moving to UPDATING_POLICY.');
    await env.ADBLOCK_KV.put(KV_KEY_STATUS, 'UPDATING_POLICY');
  } else {
    console.log(`Batch complete. Progress: ${meta.current}/${meta.total}`);
  }
}

async function handleUpdatingPolicy(env: Bindings) {
  console.log('Updating Gateway Policy...');
  const listIdsStr = await env.ADBLOCK_KV.get(KV_KEY_LIST_IDS);
  const listIds: string[] = listIdsStr ? JSON.parse(listIdsStr) : [];
  
  if (listIds.length === 0) {
    console.error('No lists created. Skipping policy update.');
    await env.ADBLOCK_KV.put(KV_KEY_STATUS, 'IDLE');
    return;
  }

  try {
    await updateGatewayPolicy(
      env.CLOUDFLARE_ACCOUNT_ID,
      env.CLOUDFLARE_API_TOKEN,
      'Block Ads (Worker)',
      listIds
    );
    console.log('Policy updated successfully.');
  } catch (e: any) {
    console.error(`Policy update failed: ${e.message}`);
  }

  // Cleanup and Finish
  await env.ADBLOCK_KV.put(KV_KEY_STATUS, 'IDLE');
  await env.ADBLOCK_KV.put(KV_KEY_LAST_RUN, Date.now().toString());
  console.log('Cycle complete.');
}

export default {
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext): Promise<void> {
    const status = (await env.ADBLOCK_KV.get(KV_KEY_STATUS)) || 'IDLE';
    console.log(`Current Status: ${status}`);

    if (status === 'IDLE') {
      const lastRun = await env.ADBLOCK_KV.get(KV_KEY_LAST_RUN);
      const now = Date.now();
      // Run if never run or > 24 hours ago
      if (!lastRun || (now - parseInt(lastRun)) > 24 * 60 * 60 * 1000) {
        console.log('Starting new update cycle...');
        await env.ADBLOCK_KV.put(KV_KEY_STATUS, 'DOWNLOADING');
        return handleDownloading(env);
      } else {
        console.log('Update not needed yet.');
      }
    } else if (status === 'DOWNLOADING') {
      await handleDownloading(env);
    } else if (status === 'UPDATING_LISTS') {
      // Pre-fetch lists to save subrequests in the batch
      const lists = await getGatewayLists(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN);
      const existingMap: Record<string, string> = {};
      lists.forEach((l: any) => existingMap[l.name] = l.id);
      await handleUpdatingLists(env, undefined, existingMap);
    } else if (status === 'UPDATING_POLICY') {
      await handleUpdatingPolicy(env);
    }
  },

  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'GET' && path === '/') {
      const status = (await env.ADBLOCK_KV.get(KV_KEY_STATUS)) || 'IDLE';
      const meta = await env.ADBLOCK_KV.get(KV_KEY_CHUNKS_META);
      const lists = await env.ADBLOCK_KV.get(KV_KEY_LIST_IDS);
      
      return new Response(JSON.stringify({
        status,
        meta: meta ? JSON.parse(meta) : null,
        lists_count: lists ? JSON.parse(lists).length : 0
      }, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (request.method === 'GET' && path === '/stream') {
      const {readable, writable} = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      const force = url.searchParams.get('force') === 'true';
      const write = async (msg: string) => {
        await writer.write(encoder.encode(msg + '\n'));
      };

      ctx.waitUntil((async () => {
        try {
          // Send initial padding (1KB) to bypass browser buffering
          await writer.write(encoder.encode(' '.repeat(1024) + '\n'));
          await write(`Starting stream processing... (Force: ${force})`);
          
          let subrequestCount = 0;
          const SUBREQUEST_LIMIT = 40; // Safe limit (max is 50 for free)
          
          // Pre-fetch Gateway lists ONCE to save subrequests
          await write(`Pre-fetching Gateway lists...`);
          const lists = await getGatewayLists(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN);
          subrequestCount++;
          const existingMap: Record<string, string> = {};
          lists.forEach((l: any) => existingMap[l.name] = l.id);
          
          // Load Status
          let status = (await env.ADBLOCK_KV.get(KV_KEY_STATUS)) || 'IDLE';
          let cachedDomains: string[] | undefined;

          // Loop until done (or platform kills us)
          while (subrequestCount < SUBREQUEST_LIMIT) {
             status = (await env.ADBLOCK_KV.get(KV_KEY_STATUS)) || 'IDLE';
             subrequestCount++; 
             
             await write(`Current Status: ${status} (Subrequests: ${subrequestCount}/${SUBREQUEST_LIMIT})`);

             if (status === 'IDLE') {
                 await write(`IDLE -> Starting new cycle.`);
                 await env.ADBLOCK_KV.put(KV_KEY_STATUS, 'DOWNLOADING');
                 subrequestCount++;
                 status = 'DOWNLOADING';
             }

             if (status === 'DOWNLOADING') {
                 await write(`Downloading and checking lists...`);
                 await handleDownloading(env, force);
                 subrequestCount += 5; // Roughly (KV reads/writes + HEAD requests)
                 
                 const newStatus = await env.ADBLOCK_KV.get(KV_KEY_STATUS);
                 subrequestCount++;
                 if (newStatus === 'IDLE') {
                     await write(`No changes detected. Stream ending.`);
                     break;
                 }

                 const fullListStr = await env.ADBLOCK_KV.get('FULL_LIST');
                 subrequestCount++;
                 if (fullListStr) cachedDomains = fullListStr.split('\n');
                 await write(`Download complete.`);
             } else if (status === 'UPDATING_LISTS') {
                 if (!cachedDomains) {
                     const fullListStr = await env.ADBLOCK_KV.get('FULL_LIST');
                     subrequestCount++;
                     if (fullListStr) cachedDomains = fullListStr.split('\n');
                 }
                 
                 await write(`Updating lists batch...`);
                 await handleUpdatingLists(env, cachedDomains, existingMap);
                 subrequestCount += BATCH_SIZE + 2; // (BATCH_SIZE fetches + KV writes)
                 
                 const metaStr = await env.ADBLOCK_KV.get(KV_KEY_CHUNKS_META);
                 subrequestCount++;
                 if (metaStr) {
                     const meta = JSON.parse(metaStr);
                     await write(`Progress: ${meta.current}/${meta.total}`);
                 }
             } else if (status === 'UPDATING_POLICY') {
                 await write(`Updating Policy...`);
                 await handleUpdatingPolicy(env);
                 subrequestCount += 3; // (KV reads + Rule fetch + Rule update)
                 await write(`Cycle Complete.`);
                 break; 
             }

             await new Promise(r => setTimeout(r, 100));
          }

          if (subrequestCount >= SUBREQUEST_LIMIT) {
              await write(`\n⚠️ Subrequest limit reached (${subrequestCount}/${SUBREQUEST_LIMIT}).`);
              await write(`Please refresh this page to continue the update process.`);
          }

        } catch (e: any) {
          await write(`Error: ${e.message}`);
        } finally {
          await writer.close();
        }
      })());

      return new Response(readable, {
        headers: { 
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        }
      });
    }

    if (request.method === 'GET' && path === '/run') {
      const status = (await env.ADBLOCK_KV.get(KV_KEY_STATUS)) || 'IDLE';
      const force = url.searchParams.get('force') === 'true';
      let result = `Ran logic for status: ${status} (Force: ${force})`;

      if (status === 'IDLE') {
          // Force start
          await env.ADBLOCK_KV.put(KV_KEY_STATUS, 'DOWNLOADING');
          ctx.waitUntil(handleDownloading(env, force));
          result = "Started DOWNLOADING cycle";
      } else if (status === 'DOWNLOADING') {
          ctx.waitUntil(handleDownloading(env, force));
      } else if (status === 'UPDATING_LISTS') {
          // Pre-fetch lists to save subrequests
          const lists = await getGatewayLists(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN);
          const existingMap: Record<string, string> = {};
          lists.forEach((l: any) => existingMap[l.name] = l.id);
          ctx.waitUntil(handleUpdatingLists(env, undefined, existingMap));
      } else if (status === 'UPDATING_POLICY') {
          ctx.waitUntil(handleUpdatingPolicy(env));
      }

      return new Response(JSON.stringify({ success: true, message: result }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (request.method === 'GET' && path === '/reset') {
      await env.ADBLOCK_KV.put(KV_KEY_STATUS, 'IDLE');
      await env.ADBLOCK_KV.delete(KV_KEY_CHUNKS_META);
      await env.ADBLOCK_KV.delete(KV_KEY_LIST_IDS);
      await env.ADBLOCK_KV.delete(KV_KEY_LAST_RUN);
      return new Response("State reset to IDLE", { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  }
};