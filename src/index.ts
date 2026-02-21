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
  deleteGatewayList,
} from "./api";

// KV Key Constants
const KV_KEY_STATUS = "status";
const KV_KEY_CHUNKS_META = "chunks_meta";
const KV_KEY_LIST_IDS = "list_ids";
const KV_KEY_LAST_RUN = "last_run";
const KV_KEY_METADATA = "source_metadata";
const KV_KEY_HEARTBEAT = "last_heartbeat";

// Processing Constants
const BATCH_SIZE = 5;
const CHUNK_PREFIX = "AdBlock_Worker_";

/**
 * Phase 1: Download blocklists and process them into chunks.
 */
async function handleDownloading(env: Bindings, forceUpdate: boolean = false) {
  await env.ADBLOCK_KV.put(KV_KEY_HEARTBEAT, Date.now().toString());
  console.log("Checking for source list changes...");

  try {
    const metadataStr = await env.ADBLOCK_KV.get(KV_KEY_METADATA);
    const currentMetadata = metadataStr ? JSON.parse(metadataStr) : {};
    const urls = env.ADBLOCK_LIST_URLS.split(",")
      .map((u) => u.trim())
      .filter((u) => u);

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
      JSON.stringify({ total: totalChunks, current: 0 }),
    );
    await env.ADBLOCK_KV.put(KV_KEY_LIST_IDS, JSON.stringify([]));
    await env.ADBLOCK_KV.put(KV_KEY_STATUS, "UPDATING_LISTS");

    console.log("Download complete. Moving to UPDATING_LISTS.");
  } catch (e: any) {
    console.error(`Download failed: ${e.message}`);
  }
}

/**
 * Phase 2: Update Gateway lists in batches.
 */
async function handleUpdatingLists(
  env: Bindings,
  cachedDomains?: string[],
  existingListsMap?: Record<string, string>,
) {
  await env.ADBLOCK_KV.put(KV_KEY_HEARTBEAT, Date.now().toString());

  const metaStr = await env.ADBLOCK_KV.get(KV_KEY_CHUNKS_META);
  if (!metaStr) {
    await env.ADBLOCK_KV.put(KV_KEY_STATUS, "IDLE");
    return;
  }

  const meta = JSON.parse(metaStr);
  const listIdsStr = await env.ADBLOCK_KV.get(KV_KEY_LIST_IDS);
  const listIds: string[] = listIdsStr ? JSON.parse(listIdsStr) : [];

  let allDomains: string[] = [];
  if (cachedDomains) {
    allDomains = cachedDomains;
  } else {
    const fullListStr = await env.ADBLOCK_KV.get("FULL_LIST");
    if (!fullListStr) {
      await env.ADBLOCK_KV.put(KV_KEY_STATUS, "DOWNLOADING");
      return;
    }
    allDomains = fullListStr.split("\n");
  }

  const maxItems = parseInt(env.MAX_ITEMS_PER_LIST) || 1000;
  const maxLists = parseInt(env.MAX_LISTS) || 90;
  let processedCount = 0;

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

  await env.ADBLOCK_KV.put(KV_KEY_CHUNKS_META, JSON.stringify(meta));
  await env.ADBLOCK_KV.put(KV_KEY_LIST_IDS, JSON.stringify(listIds));

  if (meta.current >= meta.total || meta.current >= maxLists) {
    console.log("All lists updated. Moving to UPDATING_POLICY.");
    await env.ADBLOCK_KV.put(KV_KEY_STATUS, "UPDATING_POLICY");
  } else {
    console.log(`Batch complete. Progress: ${meta.current}/${meta.total}`);
  }
}

/**
 * Phase 3: Apply the list IDs to the Gateway Policy.
 */
async function handleUpdatingPolicy(env: Bindings) {
  await env.ADBLOCK_KV.put(KV_KEY_HEARTBEAT, Date.now().toString());
  console.log("Updating Gateway Policy...");

  const listIdsStr = await env.ADBLOCK_KV.get(KV_KEY_LIST_IDS);
  const listIds: string[] = listIdsStr ? JSON.parse(listIdsStr) : [];

  if (listIds.length === 0) {
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

  await env.ADBLOCK_KV.put(KV_KEY_STATUS, "CLEANING_UP");
}

/**
 * Phase 4: Delete any Gateway lists that are no longer needed.
 */
async function handleCleanup(env: Bindings) {
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

  for (const list of toDelete) {
    console.log(`Deleting list: ${list.name} (${list.id})`);
    await deleteGatewayList(
      env.CLOUDFLARE_ACCOUNT_ID,
      env.CLOUDFLARE_API_TOKEN,
      list.id,
    );
  }

  await env.ADBLOCK_KV.put(KV_KEY_STATUS, "IDLE");
  await env.ADBLOCK_KV.put(KV_KEY_LAST_RUN, Date.now().toString());
  await env.ADBLOCK_KV.delete(KV_KEY_HEARTBEAT);
  console.log("Cleanup complete. Cycle finished.");
}

export default {
  /**
   * Cron Handler
   */
  async scheduled(
    event: ScheduledEvent,
    env: Bindings,
    ctx: ExecutionContext,
  ): Promise<void> {
    const lastHeartbeat = await env.ADBLOCK_KV.get(KV_KEY_HEARTBEAT);
    if (lastHeartbeat && Date.now() - parseInt(lastHeartbeat) < 120000) {
      console.log("Another worker is active. Skipping cron run.");
      return;
    }

    const status = (await env.ADBLOCK_KV.get(KV_KEY_STATUS)) || "IDLE";
    if (status === "IDLE") {
      const lastRun = await env.ADBLOCK_KV.get(KV_KEY_LAST_RUN);
      if (!lastRun || Date.now() - parseInt(lastRun) > 24 * 60 * 60 * 1000) {
        await env.ADBLOCK_KV.put(KV_KEY_STATUS, "DOWNLOADING");
        return handleDownloading(env);
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

  /**
   * HTTP Handler
   */
  async fetch(
    request: Request,
    env: Bindings,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- Control Center ---
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

      const urls = env.ADBLOCK_LIST_URLS.split(",")
        .map((u) => u.trim())
        .filter((u) => u);

      // Live HEAD check for updates
      const sourceStatuses = await Promise.all(
        urls.map(async (url) => {
          try {
            const res = await fetch(url, { method: "HEAD" });
            const currentEtag =
              res.headers.get("etag") ||
              res.headers.get("last-modified") ||
              "unknown";
            const storedEtag = metadata[url];
            const hasUpdate = storedEtag && storedEtag !== currentEtag;
            const name = url.split("/").pop() || url;
            return { url, name, hasUpdate, currentEtag, storedEtag };
          } catch (e) {
            return {
              url,
              name: url.split("/").pop() || url,
              error: true,
              currentEtag: "error",
            };
          }
        }),
      );

      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>ZeroAd Control Center</title>
          <style>
            body { background: #121212; color: #e0e0e0; font-family: 'Courier New', monospace; padding: 40px; line-height: 1.6; max-width: 900px; margin: 0 auto; }
            h1 { color: #64b5f6; border-bottom: 1px solid #333; padding-bottom: 10px; }
            .card { background: #1e1e1e; border: 1px solid #333; padding: 25px; border-radius: 12px; margin-bottom: 30px; }
            .stat { margin-bottom: 12px; font-size: 16px; }
            .label { color: #9e9e9e; font-weight: bold; min-width: 150px; display: inline-block; }
            .value { color: #81c784; }
            .status-value { color: #64b5f6; font-weight: bold; text-transform: uppercase; background: rgba(100, 181, 246, 0.1); padding: 2px 8px; border-radius: 4px; }
            .btn { display: inline-block; padding: 12px 24px; margin-right: 15px; margin-bottom: 15px; border-radius: 6px; text-decoration: none; font-weight: bold; cursor: pointer; transition: all 0.2s; border: none; }
            .btn-primary { background: #64b5f6; color: #121212; }
            .btn-secondary { background: #4db6ac; color: #121212; }
            .btn-danger { background: transparent; color: #ef5350; border: 1px solid #ef5350; }
            .btn:hover { opacity: 0.8; transform: translateY(-1px); }
            
            .source-table { width: 100%; border-collapse: collapse; margin-top: 10px; background: #181818; border-radius: 8px; overflow: hidden; }
            .source-table th, .source-table td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #222; }
            .source-table th { background: #222; color: #9e9e9e; font-size: 12px; text-transform: uppercase; }
            .badge { padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; text-transform: uppercase; border: 1px solid; }
            .badge-ok { background: rgba(129, 199, 132, 0.1); color: #81c784; border-color: #81c784; }
            .badge-update { background: rgba(255, 183, 77, 0.1); color: #ffb74d; border-color: #ffb74d; }
            .badge-new { background: rgba(100, 181, 246, 0.1); color: #64b5f6; border-color: #64b5f6; }
            .etag { font-size: 11px; color: #666; font-family: monospace; }
          </style>
        </head>
        <body>
          <h1>🛡️ ZeroAd Control Center</h1>
          
          <div class="card">
            <div class="stat"><span class="label">Work Status:</span> <span class="status-value">${status}</span></div>
            <div class="stat"><span class="label">Last Sync:</span> <span class="value">${lastRunDate}</span></div>
            <div class="stat"><span class="label">Active Lists:</span> <span class="value">${lists.length} registered</span></div>
            ${meta ? `<div class="stat"><span class="label">Sync Progress:</span> <span class="value">${meta.current} / ${meta.total} chunks</span></div>` : ""}
          </div>

          <div class="card">
            <div class="label" style="margin-bottom: 15px; display: block; font-size: 18px; color: #e0e0e0;">Source Blocklists</div>
            <table class="source-table">
              <thead><tr><th>List Name</th><th>Status</th><th>Stored</th><th>Current</th></tr></thead>
              <tbody>
                ${sourceStatuses
                  .map((s) => {
                    let badge = s.error
                      ? '<span class="badge badge-update">ERROR</span>'
                      : !s.storedEtag
                        ? '<span class="badge badge-new">NEW</span>'
                        : s.hasUpdate
                          ? '<span class="badge badge-update">UPDATE AVAILABLE</span>'
                          : '<span class="badge badge-ok">CURRENT</span>';
                    return `<tr>
                      <td><div style="font-weight: bold; color: #64b5f6;">${s.name}</div></td>
                      <td>${badge}</td>
                      <td><span class="etag">${s.storedEtag || "None"}</span></td>
                      <td><span class="etag">${s.currentEtag}</span></td>
                    </tr>`;
                  })
                  .join("")}
              </tbody>
            </table>
          </div>

          <div class="actions">
            <div style="margin-bottom: 20px; font-size: 14px; user-select: none; background: #1a1a1a; padding: 10px; border-radius: 8px;">
              <label style="cursor: pointer; color: #ffb74d;">
                <input type="checkbox" id="force-toggle"> Force Refresh Source Lists (Ignore ETags)
              </label>
            </div>
            <a href="/stream" id="btn-stream" class="btn btn-primary">🚀 Run Full Sync Dashboard</a>
            <a href="/run" id="btn-run" class="btn btn-secondary">⏯️ Run Next Batch</a>
            <a href="/reset" class="btn btn-danger" onclick="return confirm('Wipe all progress?')">⚠️ Reset State</a>
          </div>

          <script>
            const toggle = document.getElementById('force-toggle');
            const streamBtn = document.getElementById('btn-stream');
            const runBtn = document.getElementById('btn-run');
            toggle.addEventListener('change', () => {
              const isForce = toggle.checked;
              streamBtn.href = isForce ? '/stream?force=true' : '/stream';
              runBtn.href = isForce ? '/run?force=true' : '/run';
              if (isForce) {
                streamBtn.innerHTML = '🔥 Run Full Sync (Forced)';
                streamBtn.style.background = '#ffb74d';
              } else {
                streamBtn.innerHTML = '🚀 Run Full Sync Dashboard';
                streamBtn.style.background = '#64b5f6';
              }
            });
          </script>
        </body>
        </html>
      `;
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // --- JSON Status ---
    if (request.method === "GET" && path === "/status.json") {
      const status = (await env.ADBLOCK_KV.get(KV_KEY_STATUS)) || "IDLE";
      const meta = await env.ADBLOCK_KV.get(KV_KEY_CHUNKS_META);
      const lists = await env.ADBLOCK_KV.get(KV_KEY_LIST_IDS);
      const metadata = await env.ADBLOCK_KV.get(KV_KEY_METADATA);
      const lastRun = await env.ADBLOCK_KV.get(KV_KEY_LAST_RUN);
      return new Response(
        JSON.stringify({
          status,
          meta: meta ? JSON.parse(meta) : null,
          lists_count: lists ? JSON.parse(lists).length : 0,
          last_run: lastRun,
          sources: metadata ? JSON.parse(metadata) : {},
        }, null, 2),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // --- Streaming Dashboard ---
    if (request.method === "GET" && path === "/stream") {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      const force = url.searchParams.get("force") === "true";
      const write = async (msg: string, className: string = "") => {
        const div = className ? `<div class="${className}">${msg}</div>` : `<div>${msg}</div>`;
        await writer.write(encoder.encode(div + "\n"));
      };

      ctx.waitUntil((async () => {
        try {
          await writer.write(encoder.encode(`
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
                hr { border: 0; border-top: 1px solid #333; margin: 20px 0; }
              </style>
              <script>
                function updateProgress(current, total) {
                  const p = document.getElementById('sync-progress');
                  const t = document.getElementById('progress-text');
                  if (p && total > 0) {
                    p.value = current; p.max = total;
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
            <!-- 1KB Padding: ${" ".repeat(1024)} -->
          `));

          await write(`🚀 Starting stream processing... (Force: ${force})`, "info");
          const lists = await getGatewayLists(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN);
          const existingMap: Record<string, string> = {};
          lists.forEach((l: any) => (existingMap[l.name] = l.id));

          let subrequestCount = 1;
          const SUBREQUEST_LIMIT = 40;
          let status = (await env.ADBLOCK_KV.get(KV_KEY_STATUS)) || "IDLE";
          let cachedDomains: string[] | undefined;

          while (subrequestCount < SUBREQUEST_LIMIT) {
            status = (await env.ADBLOCK_KV.get(KV_KEY_STATUS)) || "IDLE";
            subrequestCount++;
            await write(`📍 Phase: <span class="status">${status}</span> <span class="meta">(${subrequestCount}/${SUBREQUEST_LIMIT})</span>`);

            if (status === "IDLE") {
              await env.ADBLOCK_KV.put(KV_KEY_STATUS, "DOWNLOADING");
              status = "DOWNLOADING";
            }

            if (status === "DOWNLOADING") {
              await handleDownloading(env, force);
              if ((await env.ADBLOCK_KV.get(KV_KEY_STATUS)) === "IDLE") {
                await write("✅ No changes. Stream ending.", "success");
                break;
              }
              const fullListStr = await env.ADBLOCK_KV.get("FULL_LIST");
              if (fullListStr) cachedDomains = fullListStr.split("\n");
              subrequestCount += 7;
            } else if (status === "UPDATING_LISTS") {
              if (!cachedDomains) {
                const fullListStr = await env.ADBLOCK_KV.get("FULL_LIST");
                if (fullListStr) cachedDomains = fullListStr.split("\n");
              }
              await handleUpdatingLists(env, cachedDomains, existingMap);
              const metaStr = await env.ADBLOCK_KV.get(KV_KEY_CHUNKS_META);
              if (metaStr) {
                const m = JSON.parse(metaStr);
                await writer.write(encoder.encode(`<script>updateProgress(${m.current}, ${m.total})</script>`));
              }
              subrequestCount += 8;
            } else if (status === "UPDATING_POLICY") {
              await handleUpdatingPolicy(env);
              subrequestCount += 5;
            } else if (status === "CLEANING_UP") {
              await handleCleanup(env);
              await write("✨ Cycle Complete!", "success");
              break;
            }
            await new Promise((r) => setTimeout(r, 100));
          }

          if (subrequestCount >= SUBREQUEST_LIMIT) {
            const reloadUrl = new URL(request.url);
            reloadUrl.searchParams.delete("force");
            await write("<hr>⚠️ Limit reached. Auto-reloading...", "warn");
            await writer.write(encoder.encode(`<script>setTimeout(() => { window.location.href = "${reloadUrl.toString()}"; }, 2000);</script>`));
          }
          await writer.write(encoder.encode("</body></html>"));
        } catch (e: any) {
          await write(`❌ Error: ${e.message}`, "error");
        } finally {
          await writer.close();
        }
      })());

      return new Response(readable, { headers: { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff" } });
    }

    if (request.method === "GET" && path === "/run") {
      const status = (await env.ADBLOCK_KV.get(KV_KEY_STATUS)) || "IDLE";
      if (status === "IDLE") {
        await env.ADBLOCK_KV.put(KV_KEY_STATUS, "DOWNLOADING");
        ctx.waitUntil(handleDownloading(env, url.searchParams.get("force") === "true"));
      } else if (status === "UPDATING_LISTS") {
        const lists = await getGatewayLists(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN);
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
      await Promise.all([
        env.ADBLOCK_KV.delete(KV_KEY_CHUNKS_META),
        env.ADBLOCK_KV.delete(KV_KEY_LIST_IDS),
        env.ADBLOCK_KV.delete(KV_KEY_LAST_RUN),
        env.ADBLOCK_KV.delete(KV_KEY_METADATA),
        env.ADBLOCK_KV.delete(KV_KEY_HEARTBEAT),
      ]);
      return Response.redirect(url.origin + "/", 302);
    }

    return new Response("Not Found", { status: 404 });
  },
};