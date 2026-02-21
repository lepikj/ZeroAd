/**
 * ZeroAd: Native Cloudflare Worker AdBlocker
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
import {
  Bindings,
  fetchAdBlockList,
  getGatewayLists,
  createOrUpdateGatewayList,
  updateGatewayPolicy,
} from "./api";
const KV_KEY_STATUS = "status";
const KV_KEY_CHUNKS_META = "chunks_meta";
const KV_KEY_LIST_IDS = "list_ids";
const KV_KEY_LAST_RUN = "last_run";
const CHUNK_PREFIX = "chunk_";
const BATCH_SIZE = 5; // Process 5 lists per cron execution to be safe
const KV_KEY_METADATA = "source_metadata";
async function handleDownloading(env: Bindings, forceUpdate: boolean = false) {
  // Update heartbeat
  await env.ADBLOCK_KV.put(KV_KEY_HEARTBEAT, Date.now().toString());
  console.log("Checking for source list changes...");
  try {
    const metadataStr = await env.ADBLOCK_KV.get(KV_KEY_METADATA);
    const currentMetadata = metadataStr ? JSON.parse(metadataStr) : {};
    const urls = env.ADBLOCK_LIST_URLS.split(",")
      .map((u) => u.trim())
      .filter((u) => u);
    // Pass metadata to skip if headers match, unless forced
    const result = await fetchAdBlockList(
      urls,
      forceUpdate ? {} : currentMetadata,
    );
    if (!result.updated) {
      console.log(
        "No changes detected in source lists. Skipping update cycle.",
      );
      await env.ADBLOCK_KV.put(KV_KEY_STATUS, "IDLE");
      await env.ADBLOCK_KV.put(KV_KEY_LAST_RUN, Date.now().toString());
      return;
    }
    const { blocked, allowed, metadata } = result;
    console.log(
      `Changes detected. Processing ${blocked!.size} blocked domains and ${allowed!.size} allowed domains.`,
    );
    // Apply whitelisting: remove allowed domains from blocked set
    for (const domain of allowed!) {
      blocked!.delete(domain);
    }
    const finalDomains = Array.from(blocked!);
    console.log(`Final list size after whitelisting: ${finalDomains.length}`);
    const maxItems = parseInt(env.MAX_ITEMS_PER_LIST) || 1000;
    const totalChunks = Math.ceil(finalDomains.length / maxItems);
    const fullListStr = finalDomains.join("\n");
    await env.ADBLOCK_KV.put("FULL_LIST", fullListStr);
    await env.ADBLOCK_KV.put(KV_KEY_METADATA, JSON.stringify(metadata));
    await env.ADBLOCK_KV.put(
      KV_KEY_CHUNKS_META,
      JSON.stringify({
        total: totalChunks,
        current: 0,
      }),
    );
    await env.ADBLOCK_KV.put(KV_KEY_LIST_IDS, JSON.stringify([])); // Reset list IDs
    await env.ADBLOCK_KV.put(KV_KEY_STATUS, "UPDATING_LISTS");
    console.log(
      "Download complete. Saved FULL_LIST. Moving to UPDATING_LISTS.",
    );
  } catch (e: any) {
    console.error(`Download failed: ${e.message}`);
    // Retry next time
  }
}
const KV_KEY_HEARTBEAT = "last_heartbeat";
async function handleUpdatingLists(
  env: Bindings,
  cachedDomains?: string[],
  existingListsMap?: Record<string, string>,
) {
  // Update heartbeat to signal we are active
  await env.ADBLOCK_KV.put(KV_KEY_HEARTBEAT, Date.now().toString());
  const metaStr = await env.ADBLOCK_KV.get(KV_KEY_CHUNKS_META);
  if (!metaStr) {
    await env.ADBLOCK_KV.put(KV_KEY_STATUS, "IDLE");
    return;
  }
  let meta = JSON.parse(metaStr);
  let listIdsStr = await env.ADBLOCK_KV.get(KV_KEY_LIST_IDS);
  let listIds: string[] = listIdsStr ? JSON.parse(listIdsStr) : [];
  let allDomains: string[] = [];
  if (cachedDomains) {
    allDomains = cachedDomains;
  } else {
    const fullListStr = await env.ADBLOCK_KV.get("FULL_LIST");
    if (!fullListStr) {
      console.error("FULL_LIST missing");
      await env.ADBLOCK_KV.put(KV_KEY_STATUS, "DOWNLOADING");
      return;
    }
    allDomains = fullListStr.split("\n");
  }
  const maxItems = parseInt(env.MAX_ITEMS_PER_LIST) || 1000;
  const maxLists = parseInt(env.MAX_LISTS) || 90;
  let processedCount = 0;
  // Process a batch
  while (processedCount < BATCH_SIZE && meta.current < meta.total) {
    if (meta.current >= maxLists) {
      console.warn(`Reached max lists limit (${maxLists}).`);
      break;
    }
    const chunkIndex = meta.current;
    const start = chunkIndex * maxItems;
    const end = start + maxItems;
    const chunkItems = allDomains.slice(start, end);
    const listName = `${env.LIST_PREFIX}${chunkIndex + 1}`;
    console.log(`Updating list ${listName} (${chunkItems.length} items)...`);
    try {
      const existingId = existingListsMap
        ? existingListsMap[listName]
        : undefined;
      const id = await createOrUpdateGatewayList(
        env.CLOUDFLARE_ACCOUNT_ID,
        env.CLOUDFLARE_API_TOKEN,
        listName,
        chunkItems,
        existingId,
      );
      if (id && !listIds.includes(id)) {
        listIds.push(id);
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
    console.log("All lists updated. Moving to UPDATING_POLICY.");
    await env.ADBLOCK_KV.put(KV_KEY_STATUS, "UPDATING_POLICY");
  } else {
    console.log(`Batch complete. Progress: ${meta.current}/${meta.total}`);
  }
}
async function handleUpdatingPolicy(env: Bindings) {
  // Update heartbeat
  await env.ADBLOCK_KV.put(KV_KEY_HEARTBEAT, Date.now().toString());
  console.log("Updating Gateway Policy...");
  const listIdsStr = await env.ADBLOCK_KV.get(KV_KEY_LIST_IDS);
  const listIds: string[] = listIdsStr ? JSON.parse(listIdsStr) : [];
  if (listIds.length === 0) {
    console.error("No lists created. Skipping policy update.");
    await env.ADBLOCK_KV.put(KV_KEY_STATUS, "IDLE");
    return;
  }
  try {
    await updateGatewayPolicy(
      env.CLOUDFLARE_ACCOUNT_ID,
      env.CLOUDFLARE_API_TOKEN,
      "Block Ads (Worker)",
      listIds,
    );
    console.log("Policy updated successfully.");
  } catch (e: any) {
    console.error(`Policy update failed: ${e.message}`);
  }
  // Move to Cleanup instead of IDLE
  await env.ADBLOCK_KV.put(KV_KEY_STATUS, "CLEANING_UP");
  console.log("Moving to CLEANING_UP phase.");
}
async function handleCleanup(env: Bindings) {
  // Update heartbeat
  await env.ADBLOCK_KV.put(KV_KEY_HEARTBEAT, Date.now().toString());
  console.log("Cleaning up old lists...");
  const metaStr = await env.ADBLOCK_KV.get(KV_KEY_CHUNKS_META);
  if (!metaStr) {
    await env.ADBLOCK_KV.put(KV_KEY_STATUS, "IDLE");
    return;
  }
  const meta = JSON.parse(metaStr);
  const maxUsedIndex = meta.total;
  const allLists = await getGatewayLists(
    env.CLOUDFLARE_ACCOUNT_ID,
    env.CLOUDFLARE_API_TOKEN,
  );
  const toDelete = allLists.filter((l) => {
    if (!l.name.startsWith(env.LIST_PREFIX)) return false;
    const indexPart = l.name.substring(env.LIST_PREFIX.length);
    const index = parseInt(indexPart);
    return !isNaN(index) && index > maxUsedIndex;
  });
  console.log(`Found ${toDelete.length} old lists to delete.`);
  const { deleteGatewayList } = await import("./api");
  for (const list of toDelete) {
    console.log(`Deleting list: ${list.name} (${list.id})`);
    await deleteGatewayList(
      env.CLOUDFLARE_ACCOUNT_ID,
      env.CLOUDFLARE_API_TOKEN,
      list.id,
    );
  }
  // Cleanup and Finish
  await env.ADBLOCK_KV.put(KV_KEY_STATUS, "IDLE");
  await env.ADBLOCK_KV.put(KV_KEY_LAST_RUN, Date.now().toString());
  await env.ADBLOCK_KV.delete(KV_KEY_HEARTBEAT);
  console.log("Cleanup complete. Cycle finished.");
}
export default {
  async scheduled(
    event: ScheduledEvent,
    env: Bindings,
    ctx: ExecutionContext,
  ): Promise<void> {
    // Concurrency Check: If heartbeat is fresh, another worker (like a stream) is active.
    const lastHeartbeat = await env.ADBLOCK_KV.get(KV_KEY_HEARTBEAT);
    if (lastHeartbeat && Date.now() - parseInt(lastHeartbeat) < 120000) {
      // 2 minutes
      console.log(
        "Another worker is currently active (heartbeat detected). Skipping cron run.",
      );
      return;
    }
    const status = (await env.ADBLOCK_KV.get(KV_KEY_STATUS)) || "IDLE";
    console.log(`Current Status: ${status}`);
    if (status === "IDLE") {
      const lastRun = await env.ADBLOCK_KV.get(KV_KEY_LAST_RUN);
      const now = Date.now();
      if (!lastRun || now - parseInt(lastRun) > 24 * 60 * 60 * 1000) {
        console.log("Starting new update cycle...");
        await env.ADBLOCK_KV.put(KV_KEY_STATUS, "DOWNLOADING");
        return handleDownloading(env);
      } else {
        console.log("Update not needed yet.");
      }
    } else if (status === "DOWNLOADING") {
      await handleDownloading(env);
    } else if (status === "UPDATING_LISTS") {
      const lists = await getGatewayLists(
        env.CLOUDFLARE_ACCOUNT_ID,
        env.CLOUDFLARE_API_TOKEN,
      );
      const existingMap: Record<string, string> = {};
      lists.forEach((l: any) => (existingMap[l.name] = l.id));
      await handleUpdatingLists(env, undefined, existingMap);
    } else if (status === "UPDATING_POLICY") {
      await handleUpdatingPolicy(env);
    } else if (status === "CLEANING_UP") {
      await handleCleanup(env);
    }
  },
  async fetch(
    request: Request,
    env: Bindings,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "GET" && path === "/") {
      const status = (await env.ADBLOCK_KV.get(KV_KEY_STATUS)) || "IDLE";
      const metaStr = await env.ADBLOCK_KV.get(KV_KEY_CHUNKS_META);
      const meta = metaStr ? JSON.parse(metaStr) : null;
      const listsStr = await env.ADBLOCK_KV.get(KV_KEY_LIST_IDS);
      const lists = listsStr ? JSON.parse(listsStr) : [];
      const metadataStr = await env.ADBLOCK_KV.get(KV_KEY_METADATA);
      const metadata = metadataStr ? JSON.parse(metadataStr) : {};
      const lastRun = await env.ADBLOCK_KV.get(KV_KEY_LAST_RUN);
      const lastRunDate = lastRun
        ? new Date(parseInt(lastRun)).toLocaleString()
        : "Never";
      const html = `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <title>ZeroAd Control Center</title>
            <style>
              body { background: #121212; color: #e0e0e0; font-family: 'Courier New', monospace; padding: 40px; line-height: 1.6; max-width: 800px; margin: 0 auto; }
              h1 { color: #64b5f6; border-bottom: 1px solid #333; padding-bottom: 10px; }
              .card { background: #1e1e1e; border: 1px solid #333; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
              .stat { margin-bottom: 10px; }
              .label { color: #9e9e9e; font-weight: bold; }
              .value { color: #81c784; }
              .status-value { color: #64b5f6; font-weight: bold; text-transform: uppercase; }
              .btn { display: inline-block; padding: 10px 20px; margin-right: 10px; margin-bottom: 10px; border-radius: 4px; text-decoration: none; font-weight: bold; cursor: pointer; transition: opacity 0.2s; border: none; }
              .btn-primary { background: #64b5f6; color: #121212; }
              .btn-secondary { background: #4db6ac; color: #121212; }
              .btn-danger { background: #ef5350; color: #121212; }
              .btn:hover { opacity: 0.8; }
              pre { background: #000; padding: 10px; border-radius: 4px; overflow-x: auto; font-size: 12px; border: 1px solid #222; }
              .meta-section { margin-top: 20px; }
              a.json-link { color: #9e9e9e; font-size: 12px; text-decoration: underline; }
            </style>
          </head>
          <body>
            <h1>🛡️ ZeroAd Control Center</h1>
            <div class="card">
              <div class="stat"><span class="label">Current Status:</span> <span class="status-value">${status}</span></div>
              <div class="stat"><span class="label">Last Sync:</span> <span class="value">${lastRunDate}</span></div>
              <div class="stat"><span class="label">Gateway Lists:</span> <span class="value">${lists.length} registered</span></div>
              ${meta ? `<div class="stat"><span class="label">Sync Progress:</span> <span class="value">${meta.current} / ${meta.total} chunks</span></div>` : ""}
            </div>
            <div class="actions">
              <a href="/stream" class="btn btn-primary">🚀 Run Full Sync Dashboard</a>
              <a href="/run" class="btn btn-secondary">⏯️ Run Next Batch</a>
              <a href="/reset" class="btn btn-danger" onclick="return confirm('Are you sure you want to reset the state?')">⚠️ Reset State</a>
            </div>
            <div class="meta-section">
              <div class="label">Source Metadata:</div>
              <pre>${JSON.stringify(metadata, null, 2)}</pre>
            </div>
            <div style="margin-top: 40px; text-align: right;">
              <a href="/status.json" class="json-link">View Raw JSON Status</a>
            </div>
          </body>
          </html>
        `;
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (request.method === "GET" && path === "/status.json") {
      const status = (await env.ADBLOCK_KV.get(KV_KEY_STATUS)) || "IDLE";
      const meta = await env.ADBLOCK_KV.get(KV_KEY_CHUNKS_META);
      const lists = await env.ADBLOCK_KV.get(KV_KEY_LIST_IDS);
      const metadata = await env.ADBLOCK_KV.get(KV_KEY_METADATA);
      const lastRun = await env.ADBLOCK_KV.get(KV_KEY_LAST_RUN);
      return new Response(
        JSON.stringify(
          {
            status,
            meta: meta ? JSON.parse(meta) : null,
            lists_count: lists ? JSON.parse(lists).length : 0,
            last_run: lastRun,
            sources: metadata ? JSON.parse(metadata) : {},
          },
          null,
          2,
        ),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    if (request.method === "GET" && path === "/stream") {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      const force = url.searchParams.get("force") === "true";
      const write = async (msg: string, className: string = "") => {
        const div = className
          ? `<div class="${className}">${msg}</div>`
          : `<div>${msg}</div>`;
        await writer.write(encoder.encode(div + "\n"));
      };
      ctx.waitUntil(
        (async () => {
          try {
            // Send HTML Header
            await writer.write(
              encoder.encode(`
                <!DOCTYPE html>
                <html>
                <head>
                  <meta charset="utf-8">
                  <title>ZeroAd Sync Stream</title>
                              <style>
                                  body { background: #121212; color: #e0e0e0; font-family: 'Courier New', monospace; padding: 60px 20px 20px 20px; line-height: 1.4; font-size: 14px; }
                                  #progress-container { position: fixed; top: 0; left: 0; width: 100%; background: #1e1e1e; padding: 15px 20px; border-bottom: 1px solid #333; z-index: 1000; box-sizing: border-box; }
                                  progress { width: 100%; height: 12px; appearance: none; border: none; }
                                  progress::-webkit-progress-bar { background-color: #333; border-radius: 6px; }
                                  progress::-webkit-progress-value { background-color: #64b5f6; border-radius: 6px; transition: width 0.5s ease; }
                                  .info { color: #81c784; }
                                  .status { color: #64b5f6; font-weight: bold; }
                                  .warn { color: #ffb74d; font-weight: bold; }
                                  .error { color: #ef5350; font-weight: bold; }
                                  .success { color: #4db6ac; font-weight: bold; text-decoration: underline; }
                                  .meta { color: #9e9e9e; font-style: italic; }
                                  a { color: #64b5f6; text-decoration: none; border-bottom: 1px dashed; }
                                  a:hover { border-bottom: 1px solid; }
                                  hr { border: 0; border-top: 1px solid #333; margin: 20px 0; }
                                </style>
                                <script>
                                  function updateProgress(current, total) {
                                    const p = document.getElementById('sync-progress');
                                    const t = document.getElementById('progress-text');
                                    if (p && total > 0) {
                                      p.value = current;
                                      p.max = total;
                                      const pct = Math.round((current / total) * 100);
                                      t.innerText = 'Sync Progress: ' + pct + '% (' + current + '/' + total + ')';
                                    }
                                  }
                                </script>
                              </head>
                              <body>
                              <div id="progress-container">
                                <div id="progress-text" style="margin-bottom: 5px; font-size: 12px; color: #9e9e9e;">Initializing...</div>
                                <progress id="sync-progress" value="0" max="100"></progress>
                              </div>
                              <!-- 1KB Padding to bypass browser buffering: ${" ".repeat(1024)} -->
                            `),
            );
            await write(
              `🚀 Starting stream processing... (Force: ${force})`,
              "info",
            );
            let subrequestCount = 0;
            const SUBREQUEST_LIMIT = 40;
            await write(`📡 Pre-fetching Gateway lists...`, "meta");
            const lists = await getGatewayLists(
              env.CLOUDFLARE_ACCOUNT_ID,
              env.CLOUDFLARE_API_TOKEN,
            );
            subrequestCount++;
            const existingMap: Record<string, string> = {};
            lists.forEach((l: any) => (existingMap[l.name] = l.id));
            let status = (await env.ADBLOCK_KV.get(KV_KEY_STATUS)) || "IDLE";
            let cachedDomains: string[] | undefined;
            // Initial progress if available
            const initialMeta = await env.ADBLOCK_KV.get(KV_KEY_CHUNKS_META);
            if (initialMeta) {
              const m = JSON.parse(initialMeta);
              await writer.write(
                encoder.encode(
                  `<script>updateProgress(${m.current}, ${m.total})</script>`,
                ),
              );
            }
            while (subrequestCount < SUBREQUEST_LIMIT) {
              status = (await env.ADBLOCK_KV.get(KV_KEY_STATUS)) || "IDLE";
              subrequestCount++;
              await write(
                `📍 Current Phase: <span class="status">${status}</span> <span class="meta">(Subrequests: ${subrequestCount}/${SUBREQUEST_LIMIT})</span>`,
              );
              if (status === "IDLE") {
                await write(`🆕 IDLE -> Starting new cycle.`, "info");
                await env.ADBLOCK_KV.put(KV_KEY_STATUS, "DOWNLOADING");
                subrequestCount++;
                status = "DOWNLOADING";
              }
              if (status === "DOWNLOADING") {
                await write(`📥 Downloading and checking lists...`, "info");
                await handleDownloading(env, force);
                subrequestCount += 5;
                const newStatus = await env.ADBLOCK_KV.get(KV_KEY_STATUS);
                subrequestCount++;
                if (newStatus === "IDLE") {
                  await write(
                    `✅ No changes detected. Stream ending.`,
                    "success",
                  );
                  await writer.write(
                    encoder.encode(`<script>updateProgress(100, 100)</script>`),
                  );
                  break;
                }
                const fullListStr = await env.ADBLOCK_KV.get("FULL_LIST");
                subrequestCount++;
                if (fullListStr) cachedDomains = fullListStr.split("\n");
                await write(`✔️ Download complete.`, "info");
              } else if (status === "UPDATING_LISTS") {
                if (!cachedDomains) {
                  const fullListStr = await env.ADBLOCK_KV.get("FULL_LIST");
                  subrequestCount++;
                  if (fullListStr) cachedDomains = fullListStr.split("\n");
                }
                await write(`🔄 Updating lists batch...`, "info");
                await handleUpdatingLists(env, cachedDomains, existingMap);
                subrequestCount += BATCH_SIZE + 2;
                const metaStr = await env.ADBLOCK_KV.get(KV_KEY_CHUNKS_META);
                subrequestCount++;
                if (metaStr) {
                  const meta = JSON.parse(metaStr);
                  await write(
                    `📊 Progress: <b>${meta.current}/${meta.total}</b> lists updated.`,
                    "meta",
                  );
                  await writer.write(
                    encoder.encode(
                      `<script>updateProgress(${meta.current}, ${meta.total})</script>`,
                    ),
                  );
                }
              } else if (status === "UPDATING_POLICY") {
                await writer.write(
                  encoder.encode(`<script>updateProgress(99, 100)</script>`),
                );
                await write(`🛡️ Updating Gateway Policy...`, "info");
                await handleUpdatingPolicy(env);
                subrequestCount += 3;
              } else if (status === "CLEANING_UP") {
                await writer.write(
                  encoder.encode(`<script>updateProgress(100, 100)</script>`),
                );
                await write(`🧹 Cleaning up old lists...`, "info");
                await handleCleanup(env);
                subrequestCount += 10;
                await write(
                  `✨ Cycle Complete! All lists synchronized.`,
                  "success",
                );
                break;
              }
              await new Promise((r) => setTimeout(r, 100));
            }
            if (subrequestCount >= SUBREQUEST_LIMIT) {
              const reloadUrl = new URL(request.url);
              reloadUrl.searchParams.delete("force"); // Resume without force
              await write(`<hr>`);
              await write(
                `⚠️ Subrequest limit reached (${subrequestCount}/${SUBREQUEST_LIMIT}).`,
                "warn",
              );
              await write(
                `🔄 Auto-reloading in 2 seconds to continue...`,
                "info",
              );
              await write(
                `🔗 <a href="${reloadUrl.toString()}">Click here if it doesn't reload automatically</a>`,
                "meta",
              );
              await writer.write(
                encoder.encode(`
                    <script>
                      setTimeout(() => {
                        window.location.href = "${reloadUrl.toString()}";
                      }, 2000);
                    </script>
                  `),
              );
            }
            await writer.write(encoder.encode(`</body></html>`));
          } catch (e: any) {
            await write(`❌ Error: ${e.message}`, "error");
          } finally {
            await writer.close();
          }
        })(),
      );
      return new Response(readable, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-cache",
        },
      });
    }
    if (request.method === "GET" && path === "/run") {
      const url = new URL(request.url);
      const status = (await env.ADBLOCK_KV.get(KV_KEY_STATUS)) || "IDLE";
      const force = url.searchParams.get("force") === "true";
      if (status === "IDLE") {
        await env.ADBLOCK_KV.put(KV_KEY_STATUS, "DOWNLOADING");
        ctx.waitUntil(handleDownloading(env, force));
      } else if (status === "DOWNLOADING") {
        ctx.waitUntil(handleDownloading(env, force));
      } else if (status === "UPDATING_LISTS") {
        const lists = await getGatewayLists(
          env.CLOUDFLARE_ACCOUNT_ID,
          env.CLOUDFLARE_API_TOKEN,
        );
        const existingMap: Record<string, string> = {};
        lists.forEach((l: any) => (existingMap[l.name] = l.id));
        ctx.waitUntil(handleUpdatingLists(env, undefined, existingMap));
      } else if (status === "UPDATING_POLICY") {
        ctx.waitUntil(handleUpdatingPolicy(env));
      } else if (status === "CLEANING_UP") {
        ctx.waitUntil(handleCleanup(env));
      }
      return Response.redirect(url.origin + "/", 302);
    }
    if (request.method === "GET" && path === "/reset") {
      await env.ADBLOCK_KV.put(KV_KEY_STATUS, "IDLE");
      await env.ADBLOCK_KV.delete(KV_KEY_CHUNKS_META);
      await env.ADBLOCK_KV.delete(KV_KEY_LIST_IDS);
      await env.ADBLOCK_KV.delete(KV_KEY_LAST_RUN);
      await env.ADBLOCK_KV.delete(KV_KEY_METADATA);
      await env.ADBLOCK_KV.delete(KV_KEY_HEARTBEAT);
      return Response.redirect(url.origin + "/", 302);
    }
    return new Response("Not Found", { status: 404 });
  },
};
