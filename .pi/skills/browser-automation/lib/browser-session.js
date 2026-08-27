// Persistent headless-browser session driven over CDP via puppeteer-core.
//
// A single daemon process owns the puppeteer connection (and thus the
// browser). CLI invocations talk to the daemon over a loopback HTTP API,
// which avoids the multi-client CDP races you get when several short-lived
// processes each connect to chromium directly.

import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  openSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createNetServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import puppeteer from "puppeteer-core";

const __DIR = dirname(fileURLToPath(import.meta.url));
const DAEMON_SCRIPT = join(__DIR, "..", "browser.js");
const STATE_FILE =
  process.env.BROWSER_SESSION_STATE ||
  join(tmpdir(), "dude-browser-session.json");

const t0 = Date.now();

function readState() {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state));
}

export function stateFile() {
  return STATE_FILE;
}

export function findBrowserBin() {
  const candidates = [
    process.env.WEB_BROWSE_BROWSER_BIN,
    process.env.BROWSER_BIN,
    "/run/current-system/sw/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  const dirs = (process.env.PATH || "").split(":");
  for (const dir of dirs) {
    for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
  }
  throw new Error(
    "no chromium/chrome binary found; set WEB_BROWSE_BROWSER_BIN or BROWSER_BIN",
  );
}

async function freePort() {
  return new Promise((res, rej) => {
    const srv = createNetServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => res(port));
    });
  });
}

// ---- daemon mode -----------------------------------------------------------

// chromium needs fontconfig; on minimal systems there is none and it dies
// with a fatal skia "Not implemented" crash on first text render. Build a
// tiny fonts.conf from any dejavu fonts we can find in the nix store.
function ensureFontconfig() {
  if (process.env.FONTCONFIG_FILE) return;
  try {
    const store = readdirSync("/nix/store").filter((d) => d.includes("dejavu-fonts"));
    const dirs = [];
    for (const d of store) {
      const p = join("/nix/store", d, "share", "fonts");
      if (existsSync(p)) dirs.push(p);
    }
    if (!dirs.length) return;
    const cacheDir = mkdtempSync(join(tmpdir(), "dude-fonts-cache-"));
    const confFile = join(cacheDir, "fonts.conf");
    writeFileSync(
      confFile,
      `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
${dirs.map((d) => `  <dir>${d}</dir>`).join("\n")}
  <cachedir>${cacheDir}</cachedir>
</fontconfig>
`,
    );
    process.env.FONTCONFIG_FILE = confFile;
    console.error(`[daemon ${t0}] using generated fontconfig at ${confFile}`);
  } catch (err) {
    console.error(`[daemon ${t0}] fontconfig setup failed: ${err.message}`);
  }
}

export async function runDaemon() {
  ensureFontconfig();
  const userDataDir = mkdtempSync(join(tmpdir(), "dude-browser-"));
  const apiPort = await freePort();

  const browser = await puppeteer.launch({
    executablePath: findBrowserBin(),
    headless: true,
    dumpio: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    userDataDir,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1280,900",
    ],
    defaultViewport: { width: 1280, height: 900 },
  });
  console.error(`[daemon ${t0}] launched ok`);
  let activePage = (await browser.pages())[0] || (await browser.newPage());

  // loopback command API: one JSON request per command
  const server = createHttpServer(async (req, res) => {
    if (req.url === "/ping") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, result: "pong" }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let reply = { ok: true, result: "" };
      try {
        const { action, args = [] } = JSON.parse(body || "{}");
        reply.result = await handle(action, args);
      } catch (err) {
        reply = { ok: false, error: String(err.message || err) };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(reply));
    });
  });

  async function getPage() {
    if (!activePage || activePage.isClosed()) {
      activePage = await browser.newPage();
    }
    return activePage;
  }

  browser.on("targetcreated", t => console.error(`[daemon ${t0}] targetcreated ${t.url()}`));
  browser.on("targetdestroyed", t => console.error(`[daemon ${t0}] targetdestroyed ${t.url()}`));
  async function handle(action, args) {
    try {
      const page = await getPage();
      console.error(`[daemon ${t0}] ${action} on closed=${page.isClosed()} url=${page.url()}`);
      const { actions } = await import("./browser-actions.js");
      return await actions[action](page, ...args);
    } catch (err) {
      // a navigation can orphan the cached frame; retry once on a fresh page
      if (!action) throw err;
      if (activePage && !activePage.isClosed()) {
        console.error(`[daemon ${t0}] retrying ${action} on fresh page: ${err.message}`);
        await activePage.close().catch(() => {});
      }
      activePage = null;
      const page = await getPage();
      const { actions } = await import("./browser-actions.js");
      return await actions[action](page, ...args);
    }
  }

  await new Promise((res) => server.listen(apiPort, "127.0.0.1", res));
  writeState({ apiPort, pid: process.pid, startedAt: t0 });
  console.error(`[daemon ${t0}] api listening on ${apiPort}`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await browser.close();
    } catch {}
    try {
      unlinkSync(STATE_FILE);
    } catch {}
    process.exit(0);
  };

  // idle reaper: each CLI command touches the state file; if nothing has
  // used the session for IDLE_TIMEOUT_MS, shut down so we don't leak
  // chromium processes forever.
  const idleMs = Number(process.env.BROWSER_IDLE_TIMEOUT_MS) || 30 * 60 * 1000;
  setInterval(() => {
    const st = readState();
    if (!st) return shutdown();
    if (Date.now() - st.startedAt > idleMs && Date.now() - (st.touchedAt || st.startedAt) > idleMs) {
      shutdown();
    }
  }, 30000).unref();

  const bye = (why) => () => console.error(`[daemon ${t0}] goodbye: ${why}`);
  process.on("SIGTERM", () => {
    console.error(`[daemon ${t0}] SIGTERM`);
    shutdown();
  });
  process.on("SIGINT", shutdown);
  process.on("SIGHUP", () => { console.error(`[daemon ${t0}] SIGHUP — ignoring`); });
  process.on("uncaughtException", (err) => {
    console.error(`[daemon ${t0}] uncaught:`, err);
    shutdown();
  });
  process.on("unhandledRejection", (err) => {
    console.error(`[daemon ${t0}] unhandledRejection:`, err);
  });
  process.on("exit", (code) => console.error(`[daemon ${t0}] exiting code=${code}`));
  process.on("disconnect", () => console.error("[daemon] ipc disconnect"));

  // hold the event loop open
  setInterval(() => {}, 1 << 30);
}

export function startDaemon() {
  const daemonEnv = { ...process.env };
  delete daemonEnv.NODE_TEST_CONTEXT;
  delete daemonEnv.NODE_TEST_WORKER_ID;

  const logPath = process.env.BROWSER_DAEMON_LOG || "/dev/null";
  const logFd = openSync(logPath, "a");
  const child = spawn(process.execPath, [DAEMON_SCRIPT, "_daemon"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: daemonEnv,
  });
  child.unref();
  return child.pid;
}

export async function stopSession() {
  const st = readState();
  if (!st) return false;
  try {
    if (st.pid) process.kill(st.pid, "SIGTERM");
  } catch {}
  try {
    unlinkSync(STATE_FILE);
  } catch {}
  return true;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitForApi(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = readState();
    if (st && (await ping(st))) return st;
    await sleep(200);
  }
  throw new Error("browser daemon failed to start in time");
}

async function ping(st) {
  try {
    const r = await fetch(`http://127.0.0.1:${st.apiPort}/ping`);
    return r.ok;
  } catch {
    return false;
  }
}

// send a command to the running daemon
export async function callDaemon(action, args = []) {
  touchState();
  const st = readState();
  if (!st) throw new Error("no active browser session — run `browser.js start` first");
  if (!(await ping(st))) {
    try {
      unlinkSync(STATE_FILE);
    } catch {}
    throw new Error("browser session is dead — run `browser.js start` to relaunch");
  }
  const r = await fetch(`http://127.0.0.1:${st.apiPort}/cmd`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, args }),
  });
  const payload = await r.json();
  if (!payload.ok) throw new Error(payload.error);
  return payload.result;
}

export function touchState() {
  const st = readState();
  if (st) {
    st.touchedAt = Date.now();
    writeState(st);
  }
}
