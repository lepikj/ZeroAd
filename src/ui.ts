/**
 * ZeroAd: UI Templates and Styles
 */

export const COLORS = {
  bg: "#121212",
  card: "#1e1e1e",
  text: "#e0e0e0",
  primary: "#64b5f6",
  secondary: "#4db6ac",
  danger: "#ef5350",
  success: "#81c784",
  warn: "#ffb74d",
  meta: "#9e9e9e",
  border: "#333",
};

const SHARED_STYLES = `
  body { background: ${COLORS.bg}; color: ${COLORS.text}; font-family: 'Courier New', monospace; line-height: 1.4; max-width: 900px; margin: 0 auto; font-size: 13px; }
  h1 { color: ${COLORS.primary}; border-bottom: 1px solid ${COLORS.border}; padding-bottom: 8px; display: flex; justify-content: space-between; align-items: center; font-size: 20px; }
  .card { background: ${COLORS.card}; border: 1px solid ${COLORS.border}; padding: 20px; border-radius: 10px; margin-bottom: 24px; }
  .stat { margin-bottom: 10px; font-size: 14px; }
  .label { color: ${COLORS.meta}; font-weight: bold; min-width: 140px; display: inline-block; }
  .value { color: ${COLORS.success}; }
  .status-value { color: ${COLORS.primary}; font-weight: bold; text-transform: uppercase; background: rgba(100, 181, 246, 0.1); padding: 2px 8px; border-radius: 4px; }
  .btn { display: inline-block; padding: 10px 20px; margin-right: 12px; margin-bottom: 12px; border-radius: 5px; text-decoration: none; font-weight: bold; cursor: pointer; transition: all 0.2s; border: none; font-size: 13px; }
  .btn-primary { background: ${COLORS.primary}; color: #121212; }
  .btn-secondary { background: ${COLORS.secondary}; color: #121212; }
  .btn-danger { background: transparent; color: ${COLORS.danger}; border: 1px solid ${COLORS.danger}; }
  .btn:hover { opacity: 0.8; transform: translateY(-1px); }
  .btn-danger:hover { background: ${COLORS.danger}; color: #121212; }
`;

export function renderDashboard(data: {
  status: string;
  lastRun: string;
  listsCount: number;
  progress?: { current: number; total: number };
  sourceStatuses: any[];
  metadata: any;
}) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>ZeroAd Dashboard</title>
      <style>
        ${SHARED_STYLES}
        padding: 32px;
        .source-table { width: 100%; border-collapse: collapse; margin-top: 8px; background: #181818; border-radius: 6px; overflow: hidden; }
        .source-table th, .source-table td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #222; }
        .source-table th { background: #222; color: ${COLORS.meta}; font-size: 11px; text-transform: uppercase; }
        .badge { padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; text-transform: uppercase; border: 1px solid; }
        .badge-ok { background: rgba(129, 199, 132, 0.1); color: ${COLORS.success}; border-color: ${COLORS.success}; }
        .badge-update { background: rgba(255, 183, 77, 0.1); color: ${COLORS.warn}; border-color: ${COLORS.warn}; }
        .badge-new { background: rgba(100, 181, 246, 0.1); color: ${COLORS.primary}; border-color: ${COLORS.primary}; }
        .etag { font-size: 10px; color: #666; font-family: monospace; }
        .settings-link { font-size: 13px; color: ${COLORS.meta}; text-decoration: none; border: 1px solid ${COLORS.border}; padding: 4px 12px; border-radius: 18px; }
        .settings-link:hover { background: ${COLORS.border}; color: #fff; }
      </style>
    </head>
    <body>
      <h1>
        <span>🛡️ ZeroAd Dashboard</span>
        <a href="/settings" class="settings-link">⚙️ Settings</a>
      </h1>
      
      <div class="card">
        <div class="stat"><span class="label">Work Status:</span> <span class="status-value">${data.status}</span></div>
        <div class="stat"><span class="label">Last Sync:</span> <span class="value">${data.lastRun}</span></div>
        <div class="stat"><span class="label">Active Lists:</span> <span class="value">${data.listsCount} chunks registered</span></div>
        ${data.progress ? `<div class="stat"><span class="label">Progress:</span> <span class="value">${data.progress.current} / ${data.progress.total} chunks</span></div>` : ""}
      </div>

      <div class="card">
        <div class="label" style="margin-bottom: 12px; display: block; font-size: 16px; color: ${COLORS.text};">Source Blocklists</div>
        <table class="source-table">
          <thead><tr><th>List Name</th><th>Status</th><th>Current Header</th></tr></thead>
          <tbody>
            ${data.sourceStatuses
              .map((s) => {
                let badge = s.error
                  ? `<span class="badge badge-update">ERROR</span>`
                  : !s.storedEtag
                    ? `<span class="badge badge-new">NEW</span>`
                    : s.hasUpdate
                      ? `<span class="badge badge-update">UPDATE AVAILABLE</span>`
                      : `<span class="badge badge-ok">CURRENT</span>`;
                const headerStyle = s.hasUpdate ? `color: ${COLORS.danger}; font-weight: bold;` : "";
                return `<tr>
                  <td><div style="font-weight: bold; color: ${COLORS.primary};">${s.name}</div></td>
                  <td>${badge}</td>
                  <td><span class="etag" style="${headerStyle}">${s.currentEtag}</span></td>
                </tr>`;
              })
              .join("")}
          </tbody>
        </table>
      </div>

      <div class="actions">
        <div style="margin-bottom: 16px; font-size: 13px; user-select: none; background: #1a1a1a; padding: 8px; border-radius: 8px;">
          <label style="cursor: pointer; color: ${COLORS.warn};">
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
            streamBtn.style.background = '${COLORS.warn}';
          } else {
            streamBtn.innerHTML = '🚀 Run Full Sync Dashboard';
            streamBtn.style.background = '${COLORS.primary}';
          }
        });
      </script>
    </body>
    </html>
  `;
}

export function renderSettings(data: {
  customUrls: string | null;
  defaultUrls: string;
  currentCron: string;
}) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>ZeroAd Settings</title>
      <style>
        ${SHARED_STYLES}
        padding: 32px;
        .form-group { margin-bottom: 16px; }
        label { display: block; color: ${COLORS.meta}; margin-bottom: 6px; font-weight: bold; }
        textarea, input[type="text"] { width: 100%; background: ${COLORS.bg}; border: 1px solid ${COLORS.border}; color: #fff; padding: 10px; border-radius: 5px; font-family: inherit; box-sizing: border-box; font-size: 13px; }
        .back-link { color: ${COLORS.meta}; text-decoration: none; margin-bottom: 16px; display: inline-block; font-size: 13px; }
        .hint { font-size: 11px; color: #666; margin-top: 4px; }
      </style>
    </head>
    <body>
      <a href="/" class="back-link">← Back to Dashboard</a>
      <h1>⚙️ ZeroAd Settings</h1>
      
      <form method="POST" action="/settings">
        <div class="card">
          <div class="form-group">
            <label>Source List URLs (Comma-separated)</label>
            <textarea name="urls" rows="5" placeholder="https://example.com/list.txt">${data.customUrls || data.defaultUrls}</textarea>
            <div class="hint">Leave empty to use the defaults from wrangler.toml</div>
          </div>

          <div class="form-group">
            <label>Cron Schedule</label>
            <input type="text" name="cron" value="${data.currentCron}" placeholder="*/5 * * * *">
            <div class="hint">Standard cron expression (e.g., "0 0 * * *" for daily). Leave empty to disable automation.</div>
          </div>

          <button type="submit" class="btn btn-primary">💾 Save Configuration</button>
        </div>
      </form>
    </body>
    </html>
  `;
}

export function getStreamHeader(force: boolean) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>ZeroAd Sync Stream</title>
      <style>
        ${SHARED_STYLES}
        padding: 80px 16px 16px 16px;
        line-height: 1.3;
        #progress-container { position: fixed; top: 0; left: 0; width: 100%; background: #1e1e1e; padding: 12px 16px; border-bottom: 1px solid ${COLORS.border}; z-index: 1000; box-sizing: border-box; }
        progress { width: 100%; height: 10px; appearance: none; border: none; }
        progress::-webkit-progress-bar { background-color: ${COLORS.border}; border-radius: 5px; }
        progress::-webkit-progress-value { background-color: ${COLORS.primary}; border-radius: 5px; transition: width 0.5s ease; }
        .info { color: ${COLORS.success}; }
        .status { color: ${COLORS.primary}; font-weight: bold; }
        .warn { color: ${COLORS.warn}; font-weight: bold; }
        .error { color: ${COLORS.danger}; font-weight: bold; }
        .success { color: ${COLORS.secondary}; font-weight: bold; text-decoration: underline; }
        .meta { color: ${COLORS.meta}; font-style: italic; }
        .back-link { float: right; color: ${COLORS.primary}; text-decoration: none; font-size: 11px; margin-top: 4px; }
        .back-link:hover { text-decoration: underline; }
        hr { border: 0; border-top: 1px solid ${COLORS.border}; margin: 16px 0; }
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
      <a href="/" class="back-link">← Back to Dashboard</a>
      <div id="progress-text" style="margin-bottom: 5px; font-size: 12px; color: ${COLORS.meta};">Initializing...</div>
      <progress id="sync-progress" value="0" max="100"></progress>
    </div>
    <!-- 1KB Padding: ${" ".repeat(1024)} -->
  `;
}
