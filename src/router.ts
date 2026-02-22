/**
 * ZeroAd: Hono Router for HTTP Endpoints
 */

import { Hono } from "hono";
import { Bindings, KV_KEYS, SyncStatus, CONFIG } from "./types";
import { getGatewayLists, getSchedules, updateSchedules } from "./api";
import { renderDashboard, renderSettings, getStreamHeader } from "./ui";
import { SyncEngine } from "./engine";

const app = new Hono<{ Bindings: Bindings }>();

// --- Control Center Dashboard ---
app.get("/", async (c) => {
  const engine = new SyncEngine(c.env);
  const [status, metaStr, listsStr, metadataStr, lastRun, schedules] = await Promise.all([
    c.env.ADBLOCK_KV.get(KV_KEYS.STATUS),
    c.env.ADBLOCK_KV.get(KV_KEYS.CHUNKS_META),
    c.env.ADBLOCK_KV.get(KV_KEYS.LIST_IDS),
    c.env.ADBLOCK_KV.get(KV_KEYS.METADATA),
    c.env.ADBLOCK_KV.get(KV_KEYS.LAST_RUN),
    getSchedules(c.env.CLOUDFLARE_ACCOUNT_ID, c.env.SCRIPT_NAME, c.env.CLOUDFLARE_API_TOKEN),
  ]);

  const rawUrls = (await c.env.ADBLOCK_KV.get(KV_KEYS.CUSTOM_URLS)) || c.env.ADBLOCK_LIST_URLS;
  const urls = rawUrls.split(",").map((u) => u.trim()).filter((u) => u);
  const metadata = metadataStr ? JSON.parse(metadataStr) : {};

  const sourceStatuses = await Promise.all(urls.map(async (u) => {
    try {
      const res = await fetch(u, { method: "HEAD" });
      const currentEtag = res.headers.get("etag") || res.headers.get("last-modified") || "unknown";
      const storedEtag = metadata[u];
      return { name: u.split("/").pop()!, url: u, hasUpdate: storedEtag && storedEtag !== currentEtag, currentEtag, storedEtag };
    } catch (e) {
      return { name: u.split("/").pop()!, url: u, error: true, currentEtag: "error" };
    }
  }));

  const html = renderDashboard({
    status: status || "IDLE",
    lastRun: lastRun ? new Date(parseInt(lastRun)).toLocaleString() : "Never",
    listsCount: listsStr ? JSON.parse(listsStr).length : 0,
    progress: metaStr ? JSON.parse(metaStr) : undefined,
    sourceStatuses,
    metadata,
    schedules,
  });

  return c.html(html);
});

// --- Settings Page ---
app.get("/settings", async (c) => {
  const [customUrls, schedules] = await Promise.all([
    c.env.ADBLOCK_KV.get(KV_KEYS.CUSTOM_URLS),
    getSchedules(c.env.CLOUDFLARE_ACCOUNT_ID, c.env.SCRIPT_NAME, c.env.CLOUDFLARE_API_TOKEN),
  ]);

  return c.html(renderSettings({
    customUrls,
    defaultUrls: c.env.ADBLOCK_LIST_URLS,
    currentCron: schedules[0] || "",
  }));
});

app.post("/settings", async (c) => {
  const body = await c.req.parseBody();
  const urls = body["urls"]?.toString().trim();
  const cron = body["cron"]?.toString().trim();

  if (urls) await c.env.ADBLOCK_KV.put(KV_KEYS.CUSTOM_URLS, urls);
  else await c.env.ADBLOCK_KV.delete(KV_KEYS.CUSTOM_URLS);

  await updateSchedules(c.env.CLOUDFLARE_ACCOUNT_ID, c.env.SCRIPT_NAME, c.env.CLOUDFLARE_API_TOKEN, cron ? [cron] : []);
  return c.redirect("/", 302);
});

// --- Streaming Dashboard ---
app.get("/stream", async (c) => {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const force = c.req.query("force") === "true";
  const engine = new SyncEngine(c.env);

  const write = async (msg: string, className: string = "") => {
    const div = className ? `<div class="${className}">${msg}</div>` : `<div>${msg}</div>`;
    await writer.write(encoder.encode(div + "\n"));
  };

  c.executionCtx.waitUntil((async () => {
    try {
      await writer.write(encoder.encode(getStreamHeader(force)));
      await write(`🚀 Starting stream processing...`, "info");

      const lists = await getGatewayLists(c.env.CLOUDFLARE_ACCOUNT_ID, c.env.CLOUDFLARE_API_TOKEN);
      const existingMap: Record<string, string> = {};
      lists.forEach((l: any) => (existingMap[l.name] = l.id));

      let subrequests = 1;
      let cachedDomains: string[] | undefined;

      while (subrequests < 40) {
        const status = (await c.env.ADBLOCK_KV.get(KV_KEYS.STATUS)) as SyncStatus || "IDLE";
        subrequests++;
        await write(`📍 Phase: <span class="status">${status}</span> <span class="meta">(${subrequests}/40)</span>`);

        if (status === "IDLE") {
          await c.env.ADBLOCK_KV.put(KV_KEYS.STATUS, "DOWNLOADING");
        } else if (status === "DOWNLOADING") {
          await engine.handleDownloading(force);
          if ((await c.env.ADBLOCK_KV.get(KV_KEYS.STATUS)) === "IDLE") {
            await write("✅ No changes. Ending.", "success");
            break;
          }
          const fullListStr = await c.env.ADBLOCK_KV.get(KV_KEYS.FULL_LIST);
          if (fullListStr) cachedDomains = fullListStr.split("\n");
          subrequests += 7;
        } else if (status === "UPDATING_LISTS") {
          if (!cachedDomains) {
            const fullListStr = await c.env.ADBLOCK_KV.get(KV_KEYS.FULL_LIST);
            if (fullListStr) cachedDomains = fullListStr.split("\n");
          }
          await engine.handleUpdatingLists(cachedDomains, existingMap);
          const mStr = await c.env.ADBLOCK_KV.get(KV_KEYS.CHUNKS_META);
          if (mStr) {
            const m = JSON.parse(mStr);
            await write(`📊 Progress: <b>${m.current}/${m.total}</b> updated.`, "meta");
            await writer.write(encoder.encode(`<script>updateProgress(${m.current}, ${m.total})</script>`));
          }
          subrequests += 8;
        } else if (status === "UPDATING_POLICY") {
          await engine.handleUpdatingPolicy();
          subrequests += 5;
        } else if (status === "CLEANING_UP") {
          await engine.handleCleanup();
          await write("✨ Cycle Complete!", "success");
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      if (subrequests >= 40) {
        const reloadUrl = new URL(c.req.url);
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

  return new Response(readable, {
    headers: { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff" },
  });
});

// --- Manual Run ---
app.get("/run", async (c) => {
  const engine = new SyncEngine(c.env);
  const force = c.req.query("force") === "true";
  c.executionCtx.waitUntil(engine.processNextStep(force));
  return c.redirect("/", 302);
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
