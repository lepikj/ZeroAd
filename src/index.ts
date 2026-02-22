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
  getGatewayLists,
  createOrUpdateGatewayList,
  updateGatewayPolicy,
  deleteGatewayList,
  getSchedules,
  updateSchedules,
} from "./api";
import { fetchAdBlockList } from "./parser";
import { renderDashboard, renderSettings, getStreamHeader } from "./ui";

// KV Key Constants
const KV_KEY_STATUS = "status";
const KV_KEY_CHUNKS_META = "chunks_meta";
const KV_KEY_LIST_IDS = "list_ids";
const KV_KEY_LAST_RUN = "last_run";
const KV_KEY_METADATA = "source_metadata";
const KV_KEY_HEARTBEAT = "last_heartbeat";
const KV_KEY_CUSTOM_URLS = "config_urls";

// Processing Constants
const BATCH_SIZE = 5;

/**
 * Phase 1: Download blocklists and process them into chunks.
 */
async function handleDownloading(env: Bindings, forceUpdate: boolean = false) {
  await env.ADBLOCK_KV.put(KV_KEY_HEARTBEAT, Date.now().toString());
  console.log("Checking for source list changes...");

  try {
    const metadataStr = await env.ADBLOCK_KV.get(KV_KEY_METADATA);
    const currentMetadata = metadataStr ? JSON.parse(metadataStr) : {};

    const rawUrls =
      (await env.ADBLOCK_KV.get(KV_KEY_CUSTOM_URLS)) || env.ADBLOCK_LIST_URLS;
    const urls = rawUrls
      .split(",")
      .map((u) => u.trim())
      .filter((u) => u);

    const result = await fetchAdBlockList(
      urls,
      forceUpdate ? {} : currentMetadata,
    );

    if (!result.updated) {
      console.log("No changes detected. Skipping update cycle.");
      await env.ADBLOCK_KV.put(KV_KEY_STATUS, "IDLE");
      await env.ADBLOCK_KV.put(KV_KEY_LAST_RUN, Date.now().toString());
      return;
    }

    const { blocked, allowed, metadata } = result;
    for (const domain of allowed!) {
      blocked!.delete(domain);
    }

    const finalDomains = Array.from(blocked!);
    const maxItems = parseInt(env.MAX_ITEMS_PER_LIST) || 1000;
    const totalChunks = Math.ceil(finalDomains.length / maxItems);

    await env.ADBLOCK_KV.put("FULL_LIST", finalDomains.join("\n"));
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
    if (meta.current >= maxLists) break;

    const chunkIndex = meta.current;
    const chunkItems = allDomains.slice(
      chunkIndex * maxItems,
      (chunkIndex + 1) * maxItems,
    );
    const listName = `${env.LIST_PREFIX}${chunkIndex + 1}`;

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
      if (id && !listIds.includes(id)) listIds.push(id);
    } catch (e: any) {
      console.error(`Failed to update list ${listName}: ${e.message}`);
    }

    meta.current++;
    processedCount++;
  }

  await env.ADBLOCK_KV.put(KV_KEY_CHUNKS_META, JSON.stringify(meta));
  await env.ADBLOCK_KV.put(KV_KEY_LIST_IDS, JSON.stringify(listIds));

  if (meta.current >= meta.total || meta.current >= maxLists) {
    await env.ADBLOCK_KV.put(KV_KEY_STATUS, "UPDATING_POLICY");
  }
}

/**
 * Phase 3: Apply policy.
 */
async function handleUpdatingPolicy(env: Bindings) {
  await env.ADBLOCK_KV.put(KV_KEY_HEARTBEAT, Date.now().toString());
  const listIdsStr = await env.ADBLOCK_KV.get(KV_KEY_LIST_IDS);
  const listIds: string[] = listIdsStr ? JSON.parse(listIdsStr) : [];

  if (listIds.length > 0) {
    try {
      await updateGatewayPolicy(
        env.CLOUDFLARE_ACCOUNT_ID,
        env.CLOUDFLARE_API_TOKEN,
        "Block Ads (Managed by Worker)",
        listIds,
      );
    } catch (e: any) {
      console.error(`Policy update failed: ${e.message}`);
    }
  }
  await env.ADBLOCK_KV.put(KV_KEY_STATUS, "CLEANING_UP");
}

/**
 * Phase 4: Cleanup.
 */
async function handleCleanup(env: Bindings) {
  await env.ADBLOCK_KV.put(KV_KEY_HEARTBEAT, Date.now().toString());
  const metaStr = await env.ADBLOCK_KV.get(KV_KEY_CHUNKS_META);
  if (metaStr) {
    const meta = JSON.parse(metaStr);
    const allLists = await getGatewayLists(
      env.CLOUDFLARE_ACCOUNT_ID,
      env.CLOUDFLARE_API_TOKEN,
    );
    const toDelete = allLists.filter((l) => {
      if (!l.name.startsWith(env.LIST_PREFIX)) return false;
      const index = parseInt(l.name.substring(env.LIST_PREFIX.length));
      return !isNaN(index) && index > meta.total;
    });

    for (const list of toDelete) {
      await deleteGatewayList(
        env.CLOUDFLARE_ACCOUNT_ID,
        env.CLOUDFLARE_API_TOKEN,
        list.id,
      );
    }
  }

  await env.ADBLOCK_KV.put(KV_KEY_STATUS, "IDLE");
  await env.ADBLOCK_KV.put(KV_KEY_LAST_RUN, Date.now().toString());
  await env.ADBLOCK_KV.delete(KV_KEY_HEARTBEAT);
}

export default {
  async scheduled(
    event: ScheduledEvent,
    env: Bindings,
    ctx: ExecutionContext,
  ): Promise<void> {
    const lastHeartbeat = await env.ADBLOCK_KV.get(KV_KEY_HEARTBEAT);
    if (lastHeartbeat && Date.now() - parseInt(lastHeartbeat) < 120000) return;

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

  async fetch(
    request: Request,
    env: Bindings,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- Dashboard ---
    if (request.method === "GET" && path === "/") {
      const status = (await env.ADBLOCK_KV.get(KV_KEY_STATUS)) || "IDLE";
      const metaStr = await env.ADBLOCK_KV.get(KV_KEY_CHUNKS_META);
      const listsStr = await env.ADBLOCK_KV.get(KV_KEY_LIST_IDS);
      const metadataStr = await env.ADBLOCK_KV.get(KV_KEY_METADATA);
      const lastRun = await env.ADBLOCK_KV.get(KV_KEY_LAST_RUN);

      const rawUrls =
        (await env.ADBLOCK_KV.get(KV_KEY_CUSTOM_URLS)) || env.ADBLOCK_LIST_URLS;
      const urls = rawUrls
        .split(",")
        .map((u) => u.trim())
        .filter((u) => u);
      const metadata = metadataStr ? JSON.parse(metadataStr) : {};

      const [sourceStatuses, schedules] = await Promise.all([
        Promise.all(
          urls.map(async (u) => {
            try {
              const res = await fetch(u, { method: "HEAD" });
              const currentEtag =
                res.headers.get("etag") ||
                res.headers.get("last-modified") ||
                "unknown";
              const storedEtag = metadata[u];
              return {
                name: u.split("/").pop(),
                hasUpdate: storedEtag && storedEtag !== currentEtag,
                currentEtag,
                storedEtag,
              };
            } catch (e) {
              return {
                name: u.split("/").pop(),
                error: true,
                currentEtag: "error",
              };
            }
          }),
        ),
        getSchedules(
          env.CLOUDFLARE_ACCOUNT_ID,
          env.SCRIPT_NAME,
          env.CLOUDFLARE_API_TOKEN,
        ),
      ]);

      return new Response(
        renderDashboard({
          status,
          lastRun: lastRun
            ? new Date(parseInt(lastRun)).toLocaleString()
            : "Never",
          listsCount: listsStr ? JSON.parse(listsStr).length : 0,
          progress: metaStr ? JSON.parse(metaStr) : undefined,
          sourceStatuses,
          metadata,
        }),
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }

    // --- Settings ---
    if (request.method === "GET" && path === "/settings") {
      const customUrls = await env.ADBLOCK_KV.get(KV_KEY_CUSTOM_URLS);
      const schedules = await getSchedules(
        env.CLOUDFLARE_ACCOUNT_ID,
        env.SCRIPT_NAME,
        env.CLOUDFLARE_API_TOKEN,
      );
      return new Response(
        renderSettings({
          customUrls,
          defaultUrls: env.ADBLOCK_LIST_URLS,
          currentCron: schedules[0] || "",
        }),
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }

    if (request.method === "POST" && path === "/settings") {
      const formData = await request.formData();
      const urls = formData.get("urls")?.toString().trim();
      const cron = formData.get("cron")?.toString().trim();
      if (urls) await env.ADBLOCK_KV.put(KV_KEY_CUSTOM_URLS, urls);
      else await env.ADBLOCK_KV.delete(KV_KEY_CUSTOM_URLS);
      await updateSchedules(
        env.CLOUDFLARE_ACCOUNT_ID,
        env.SCRIPT_NAME,
        env.CLOUDFLARE_API_TOKEN,
        cron ? [cron] : [],
      );
      return Response.redirect(url.origin + "/", 302);
    }

    // --- Stream ---
    if (request.method === "GET" && path === "/stream") {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      const force = url.searchParams.get("force") === "true";
      const write = async (msg: string, className: string = "") => {
        await writer.write(
          encoder.encode(
            (className
              ? `<div class="${className}">${msg}</div>`
              : `<div>${msg}</div>`) + "\n",
          ),
        );
      };

      ctx.waitUntil(
        (async () => {
          try {
            await writer.write(encoder.encode(getStreamHeader(force)));
            await write(`🚀 Starting stream processing...`, "info");
            const lists = await getGatewayLists(
              env.CLOUDFLARE_ACCOUNT_ID,
              env.CLOUDFLARE_API_TOKEN,
            );
            const existingMap: Record<string, string> = {};
            lists.forEach((l: any) => (existingMap[l.name] = l.id));

            let subrequests = 1;
            while (subrequests < 40) {
              const status =
                (await env.ADBLOCK_KV.get(KV_KEY_STATUS)) || "IDLE";
              subrequests++;
              await write(
                `📍 Phase: <span class="status">${status}</span> <span class="meta">(${subrequests}/40)</span>`,
              );

              if (status === "IDLE") {
                await env.ADBLOCK_KV.put(KV_KEY_STATUS, "DOWNLOADING");
              } else if (status === "DOWNLOADING") {
                await handleDownloading(env, force);
                if ((await env.ADBLOCK_KV.get(KV_KEY_STATUS)) === "IDLE") {
                  await write("✅ No changes. Ending.", "success");
                  break;
                }
                subrequests += 7;
              } else if (status === "UPDATING_LISTS") {
                await handleUpdatingLists(env, undefined, existingMap);
                const m = JSON.parse(
                  (await env.ADBLOCK_KV.get(KV_KEY_CHUNKS_META)) || "{}",
                );
                await write(
                  `📊 Progress: <b>${m.current}/${m.total}</b>`,
                  "meta",
                );
                await writer.write(
                  encoder.encode(
                    `<script>updateProgress(${m.current}, ${m.total})</script>`,
                  ),
                );
                subrequests += 8;
              } else if (status === "UPDATING_POLICY") {
                await handleUpdatingPolicy(env);
                subrequests += 5;
              } else if (status === "CLEANING_UP") {
                await handleCleanup(env);
                await write("✨ Cycle Complete!", "success");
                break;
              }
              await new Promise((r) => setTimeout(r, 100));
            }
            if (subrequests >= 40) {
              const reloadUrl = new URL(request.url);
              reloadUrl.searchParams.delete("force");
              await write("<hr>⚠️ Limit reached. Reloading...", "warn");
              await writer.write(
                encoder.encode(
                  `<script>setTimeout(() => { window.location.href = "${reloadUrl.toString()}"; }, 2000);</script>`,
                ),
              );
            }
            await writer.write(encoder.encode("</body></html>"));
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
        },
      });
    }

    // --- Status JSON ---
    if (request.method === "GET" && path === "/status.json") {
      const [status, meta, lists, metadata, lastRun] = await Promise.all([
        env.ADBLOCK_KV.get(KV_KEY_STATUS),
        env.ADBLOCK_KV.get(KV_KEY_CHUNKS_META),
        env.ADBLOCK_KV.get(KV_KEY_LIST_IDS),
        env.ADBLOCK_KV.get(KV_KEY_METADATA),
        env.ADBLOCK_KV.get(KV_KEY_LAST_RUN),
      ]);
      return new Response(
        JSON.stringify(
          {
            status: status || "IDLE",
            meta: meta ? JSON.parse(meta) : null,
            lists_count: lists ? JSON.parse(lists).length : 0,
            last_run: lastRun,
            sources: metadata ? JSON.parse(metadata) : {},
          },
          null,
          2,
        ),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // --- Manual Run ---
    if (request.method === "GET" && path === "/run") {
      const status = (await env.ADBLOCK_KV.get(KV_KEY_STATUS)) || "IDLE";
      if (status === "IDLE") {
        await env.ADBLOCK_KV.put(KV_KEY_STATUS, "DOWNLOADING");
        ctx.waitUntil(
          handleDownloading(env, url.searchParams.get("force") === "true"),
        );
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

    // --- Reset ---
    if (request.method === "GET" && path === "/reset") {
      await env.ADBLOCK_KV.put(KV_KEY_STATUS, "IDLE");
      await Promise.all(
        [
          KV_KEY_CHUNKS_META,
          KV_KEY_LIST_IDS,
          KV_KEY_LAST_RUN,
          KV_KEY_METADATA,
          KV_KEY_HEARTBEAT,
        ].map((k) => env.ADBLOCK_KV.delete(k)),
      );
      return Response.redirect(url.origin + "/", 302);
    }

    return new Response("Not Found", { status: 404 });
  },
};
