#!/usr/bin/env node
/**
 * dude2 log viewer (phase 4) — a small node http UI over the unified run
 * logs: list runs, drill into sourced entries (dispatcher / pi-stdout /
 * pi-session / agent), rate + annotate runs (us4).
 *
 * usage: node tools/logviewer/server.js [--port 4722]
 * paths come from the dude2 config env (nix rule); read-only on the log
 * db except the annotation columns.
 */

import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { loadConfig } from "../../src/dude2/config.js";
import { openLogIndex, listRuns, runEntries, annotateRun } from "../../src/dude2/logging.js";

const cfg = loadConfig();
const port = Number(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 4722);
const db = openLogIndex(cfg);

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>dude2 logs</title><style>
body { font-family: ui-monospace, monospace; background: #111; color: #ddd; margin: 2rem; }
h1 { color: #9df; } h2 { color: #ccf; margin-top: 2rem; }
table { border-collapse: collapse; width: 100%; }
td, th { border: 1px solid #333; padding: 4px 8px; text-align: left; font-size: 13px; }
a { color: #7cf; }
.badge { display: inline-block; padding: 0 6px; border-radius: 4px; font-size: 11px; }
.dispatcher { background: #345; } .pi-stdout { background: #354; }
.pi-session { background: #453; } .agent { background: #433; }
pre { white-space: pre-wrap; background: #1a1a1a; padding: 6px; border-radius: 4px; font-size: 12px; }
input, button, select { background: #222; color: #ddd; border: 1px solid #444; padding: 4px; }
</style></head><body>
<h1>dude2 run logs</h1>
<div id="app">loading...</div>
<script>
async function j(url, opts) { const r = await fetch(url, opts); return r.json(); }
let runs = [];
async function refresh() {
  runs = await j("/api/runs");
  const rows = runs.map(r =>
    '<tr><td><a href="#" onclick="openRun(\\'' + r.run_id + '\\');return false">' + r.run_id + '</a></td>' +
    '<td>' + (r.purpose || '') + '</td><td>' + (r.started_at || '') + '</td>' +
    '<td>' + (r.exit_code ?? '') + '</td><td>' + r.entries + '</td>' +
    '<td>' + (r.rating ?? '-') + '</td><td>' + (r.annotation || '') + '</td></tr>').join('');
  document.getElementById('app').innerHTML =
    '<table><tr><th>run</th><th>purpose</th><th>started</th><th>exit</th><th>entries</th><th>rating</th><th>annotation</th></tr>' + rows + '</table>';
}
async function openRun(runId) {
  const entries = await j('/api/runs/' + runId + '/entries');
  const html = entries.map(e =>
    '<div><span class="badge ' + e.source + '">' + e.source + '</span> <small>' + e.ts + '</small>' +
    (e.file ? ' <small>[' + e.file + ']</small>' : '') + '<pre>' +
    (e.text || '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])) + '</pre></div>').join('');
  document.getElementById('app').innerHTML =
    '<a href="#" onclick="refresh();return false">&larr; all runs</a> <h2>' + runId + '</h2>' + html +
    '<h2>rate / annotate</h2><form onsubmit="return annotate(\\'' + runId + '\\')">' +
    '<select id="rating"><option></option><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option></select> ' +
    '<input id="annotation" placeholder="annotation" style="width:60%"> <button>save</button></form>';
}
async function annotate(runId) {
  await j('/api/runs/' + runId + '/annotate', { method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({ rating: document.getElementById('rating').value || null, annotation: document.getElementById('annotation').value || null }) });
  refresh(); return false;
}
refresh();
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.setHeader("content-type", "application/json");
  try {
    if (url.pathname === "/api/runs") return json(res, listRuns(db));
    const m = url.pathname.match(/^\/api\/runs\/([^/]+)\/entries$/);
    if (m) return json(res, runEntries(db, m[1], { source: url.searchParams.get("source") }));
    const a = url.pathname.match(/^\/api\/runs\/([^/]+)\/annotate$/);
    if (a && req.method === "POST") {
      const body = await readBody(req);
      annotateRun(db, a[1], body);
      return json(res, { ok: true });
    }
    if (url.pathname === "/") {
      res.setHeader("content-type", "text/html");
      return res.end(HTML);
    }
    res.statusCode = 404;
    return res.end('{"error":"not found"}');
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: e?.message || String(e) }));
  }
});

function json(res, data) {
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(b || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith("server.js");
if (isMain) {
  server.listen(port, () => console.log(`dude2 log viewer on http://localhost:${port} (logDir=${cfg.logDir})`));
}
export { server };
