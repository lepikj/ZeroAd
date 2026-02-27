/**
 * ZeroAd: Hono Router for HTTP Endpoints
 */

import { Hono } from "hono";
import { Bindings, KV_KEYS, SyncStatus, CONFIG } from "./types";
import { getGatewayLists, getSchedules, updateSchedules } from "./api";
import { renderDashboard, renderSettings, getStreamHeader } from "./ui";
import { SyncEngine } from "./engine";

const app = new Hono<{ Bindings: Bindings }>();

// --- Dashboard ---
app.get("/", async (c) => {
  const engine = new SyncEngine(c.env);
  const [
    status,
    metaStr,
    listsStr,
    metadataStr,
    lastRun,
    schedules,
    syncIntervalMs,
  ] = await Promise.all([
    c.env.ADBLOCK_KV.get(KV_KEYS.STATUS),
    c.env.ADBLOCK_KV.get(KV_KEYS.CHUNKS_META),
    c.env.ADBLOCK_KV.get(KV_KEYS.LIST_IDS),
    c.env.ADBLOCK_KV.get(KV_KEYS.METADATA),
    c.env.ADBLOCK_KV.get(KV_KEYS.LAST_RUN),
    getSchedules(
      c.env.CLOUDFLARE_ACCOUNT_ID,
      c.env.SCRIPT_NAME,
      c.env.CLOUDFLARE_API_TOKEN,
    ),
    engine.getSyncInterval(),
  ]);

  // Workflow & System Info
  let workflowInfo = null;
  try {
    const list = await (c.env as any).ADBLOCK_SYNC_WORKFLOW.list({ limit: 1 });
    if (list.instances && list.instances.length > 0) {
      const latest = list.instances[0];
      const fullInstance = await (c.env as any).ADBLOCK_SYNC_WORKFLOW.get(latest.id);
      const statusObj = await fullInstance.status();
      workflowInfo = {
        id: latest.id,
        status: statusObj.status,
        error: statusObj.error,
        updatedAt: statusObj.updatedAt
      };
    }
  } catch (e) {}

  let r2Count = 0;
  try {
    const objects = await c.env.SYNC_BUCKET.list();
    r2Count = objects.objects.length;
  } catch (e) {}

  const colo = (c.req.raw as any).cf?.colo || 'N/A';
  const version = c.env.CF_VERSION_METADATA || { id: 'dev', timestamp: new Date().toISOString() };

  const rawUrls =
    (await c.env.ADBLOCK_KV.get(KV_KEYS.CUSTOM_URLS)) ||
    c.env.ADBLOCK_LIST_URLS;
  const urls = rawUrls
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u);
  const metadata = metadataStr ? JSON.parse(metadataStr) : {};

  const sourceStatuses = await Promise.all(
    urls.map(async (u) => {
      try {
        const res = await fetch(u, { method: "HEAD" });
        const currentEtag =
          res.headers.get("etag") ||
          res.headers.get("last-modified") ||
          "unknown";
        const storedEtag = metadata[u];
        return {
          name: u.split("/").pop()!,
          url: u,
          hasUpdate: storedEtag && storedEtag !== currentEtag,
          currentEtag,
          storedEtag,
        };
      } catch (e) {
        return {
          name: u.split("/").pop()!,
          url: u,
          error: true,
          currentEtag: "error",
        };
      }
    }),
  );

  return c.html(
    renderDashboard({
      status: status || "IDLE",
      lastRun: lastRun ? new Date(parseInt(lastRun)).toLocaleString() : "Never",
      listsCount: listsStr ? JSON.parse(listsStr).length : 0,
      progress: metaStr ? JSON.parse(metaStr) : undefined,
      sourceStatuses,
      metadata,
      schedules,
      syncInterval: (syncIntervalMs / (60 * 60 * 1000)).toString(),
      systemIntel: {
        colo,
        versionId: version.id,
        versionTime: version.timestamp,
        r2Count,
        workflow: workflowInfo
      }
    }),
  );
});

// --- Settings ---
app.get("/settings", async (c) => {
  const engine = new SyncEngine(c.env);
  const [customUrls, schedules, syncIntervalMs] = await Promise.all([
    c.env.ADBLOCK_KV.get(KV_KEYS.CUSTOM_URLS),
    getSchedules(
      c.env.CLOUDFLARE_ACCOUNT_ID,
      c.env.SCRIPT_NAME,
      c.env.CLOUDFLARE_API_TOKEN,
    ),
    engine.getSyncInterval(),
  ]);

  return c.html(
    renderSettings({
      customUrls,
      defaultUrls: c.env.ADBLOCK_LIST_URLS,
      currentCron: schedules[0] || "",
      syncInterval: (syncIntervalMs / (60 * 60 * 1000)).toString(),
    }),
  );
});

app.post("/settings", async (c) => {
  const body = await c.req.parseBody();
  const urls = body["urls"]?.toString().trim();
  const cron = body["cron"]?.toString().trim();
  const interval = body["interval"]?.toString().trim();

  // Save URLs to KV
  if (urls) await c.env.ADBLOCK_KV.put(KV_KEYS.CUSTOM_URLS, urls);
  else await c.env.ADBLOCK_KV.delete(KV_KEYS.CUSTOM_URLS);

  // Save Interval to KV
  if (interval) await c.env.ADBLOCK_KV.put(KV_KEYS.SYNC_INTERVAL, interval);
  else await c.env.ADBLOCK_KV.delete(KV_KEYS.SYNC_INTERVAL);

  // Update Cron Schedule via API
  await updateSchedules(
    c.env.CLOUDFLARE_ACCOUNT_ID,
    c.env.SCRIPT_NAME,
    c.env.CLOUDFLARE_API_TOKEN,
    cron ? [cron] : [],
  );

  return c.redirect("/", 302);
});

// --- Stream ---
app.get("/stream", async (c) => {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const force = c.req.query("force") === "true";
  const engine = new SyncEngine(c.env);

  const write = async (msg: string, className: string = "") => {
    await writer.write(
      encoder.encode(
        (className
          ? `<div class="${className}">${msg}</div>`
          : `<div>${msg}</div>`) + "\n",
      ),
    );
  };

  c.executionCtx.waitUntil(
    (async () => {
      try {
        await writer.write(encoder.encode(getStreamHeader(force)));
        await write(`🚀 Starting stream processing...`, "info");

        // Optimization: Prefetch Gateway lists once
        const lists = await getGatewayLists(
          c.env.CLOUDFLARE_ACCOUNT_ID,
          c.env.CLOUDFLARE_API_TOKEN,
        );
        const existingMap: Record<string, string> = {};
        lists.forEach((l: any) => (existingMap[l.name] = l.id));

        let subrequests = 1;
        let cachedDomains: string[] | undefined;

        // Callback to bridge Engine logic to UI stream
        const onProgress = async (msg: string, type?: string, meta?: any) => {
          await write(msg, type);
          if (meta && meta.current !== undefined) {
            await writer.write(
              encoder.encode(
                `<script>updateProgress(${meta.current}, ${meta.total})</script>`,
              ),
            );
          }
        };

        while (subrequests < 40) {
          const statusBefore =
            ((await c.env.ADBLOCK_KV.get(KV_KEYS.STATUS)) as SyncStatus) ||
            "IDLE";

          // Call unified orchestration
          const statusAfter = await engine.processNextStep(
            force,
            onProgress,
            cachedDomains,
            existingMap,
          );

          subrequests += 8; // Conservative estimate per step

          if (statusAfter === "IDLE") {
            // Check if we exited early due to no changes
            if (statusBefore === "DOWNLOADING") {
              // Dashboard already wrote "No changes detected"
            }
            break;
          }

          // In-memory cache for domain list to save KV reads during loop
          if (!cachedDomains && statusAfter === "UPDATING_LISTS") {
            const fullListStr = await c.env.ADBLOCK_KV.get(KV_KEYS.FULL_LIST);
            if (fullListStr) cachedDomains = fullListStr.split("\n");
          }

          await new Promise((r) => setTimeout(r, 100));
        }

        if (subrequests >= 40) {
          const reloadUrl = new URL(c.req.url);
          reloadUrl.searchParams.delete("force");
          await write("<hr>⚠️ Limit reached. Auto-reloading...", "warn");
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
});

// --- Manual Run ---
app.get("/run", async (c) => {
  const engine = new SyncEngine(c.env);
  const force = c.req.query("force") === "true";
  c.executionCtx.waitUntil(engine.processNextStep(force));
  return c.redirect("/", 302);
});

// --- Workflow Manual Run ---
app.get("/workflow/run", async (c) => {
  const force = c.req.query("force") === "true";
  await (c.env as any).ADBLOCK_SYNC_WORKFLOW.create({
    params: { force }
  });
  return c.json({ success: true, message: "Workflow started" });
});

// --- Reset ---
app.get("/reset", async (c) => {
  const engine = new SyncEngine(c.env);
  await engine.resetState();
  return c.redirect("/", 302);
});

// --- JSON Status ---
app.get("/status.json", async (c) => {
  const [status, meta, lists, metadata, lastRun] = await Promise.all([
    c.env.ADBLOCK_KV.get(KV_KEYS.STATUS),
    c.env.ADBLOCK_KV.get(KV_KEYS.CHUNKS_META),
    c.env.ADBLOCK_KV.get(KV_KEYS.LIST_IDS),
    c.env.ADBLOCK_KV.get(KV_KEYS.METADATA),
    c.env.ADBLOCK_KV.get(KV_KEYS.LAST_RUN),
  ]);

  return c.json({
    status: status || "IDLE",
    meta: meta ? JSON.parse(meta) : null,
    lists_count: lists ? JSON.parse(lists).length : 0,
    last_run: lastRun,
    sources: metadata ? JSON.parse(metadata) : {},
  });
});

export default app;
