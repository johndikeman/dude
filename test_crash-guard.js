// tests for src/crash-guard.js — runs the guard in child node processes
// because uncaughtException handlers must be exercised for real.
import assert from "node:assert";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const here = path.dirname(fileURLToPath(import.meta.url));

function runChild(code) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", code], {
      cwd: here,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    child.on("exit", (code_, signal) => resolve({ code: code_, signal, out }));
  });
}

const GUARD = `import { installCrashGuard } from "./src/crash-guard.js"; installCrashGuard({ log: (m) => console.log(m) });`;

const results = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => results.push(`ok - ${name}`))
    .catch((e) => {
      console.error(`fail - ${name}: ${e?.message || e}`);
      process.exitCode = 1;
    });
}

await Promise.all([
  test("survives an uncaught ws handshake timeout from the ws layer", async () => {
    const r = await runChild(`
      ${GUARD}
      setTimeout(() => {
        const e = new Error("Opening handshake has timed out");
        e.stack = "Error: Opening handshake has timed out\\n    at ClientRequest.<anonymous> (/x/dude-agent/node_modules/ws/lib/websocket.js:890:7)";
        throw e;
      }, 10);
      setTimeout(() => { console.log("STILL_ALIVE"); process.exit(0); }, 150);
    `);
    assert.strictEqual(r.code, 0, `exit ${r.code}: ${r.out}`);
    assert.ok(r.out.includes("swallowed transient"), `no swallow log: ${r.out}`);
    assert.ok(r.out.includes("STILL_ALIVE"), `process died: ${r.out}`);
  }),

  test("survives an unhandled ws rejection", async () => {
    const r = await runChild(`
      ${GUARD}
      setTimeout(() => {
        const e = new Error("read ECONNRESET");
        e.stack = "Error: read ECONNRESET\\n    at (/x/node_modules/@discordjs/ws/dist/index.js:1:1)";
        Promise.reject(e);
      }, 10);
      setTimeout(() => { console.log("STILL_ALIVE"); process.exit(0); }, 150);
    `);
    assert.strictEqual(r.code, 0, `exit ${r.code}: ${r.out}`);
    assert.ok(r.out.includes("STILL_ALIVE"), `process died: ${r.out}`);
  }),

  test("still exits 1 on a genuine (non-ws) uncaught exception", async () => {
    const r = await runChild(`
      ${GUARD}
      setTimeout(() => { null.crashMe; }, 10);
    `);
    assert.strictEqual(r.code, 1, `expected exit 1, got ${r.code}: ${out(r)}`);
  }),

  test("does not swallow transient-looking errors from our own code", async () => {
    const r = await runChild(`
      ${GUARD}
      setTimeout(() => {
        const e = new Error("opening handshake has timed out");
        e.stack = "Error: opening handshake has timed out\\n    at sendNotify (file:///home/ubuntu/dude/src/notify.js:117:1)";
        throw e;
      }, 10);
    `);
    // stack has no ws/@discordjs path → must NOT be swallowed
    assert.strictEqual(r.code, 1, `expected exit 1, got ${r.code}: ${out(r)}`);
  }),

  test("survives a TLS connect error from node:internal/tls (undici-style)", async () => {
    // incident 2026-11-06: hung llm request surfaced as uncaughtException
    // with only node-internal stack frames; killed a mid-task run.
    const r = await runChild(`
      ${GUARD}
      setTimeout(() => {
        const e = new Error("Client network socket disconnected before secure TLS connection was established");
        e.stack = "Error: Client network socket disconnected before secure TLS connection was established\\n    at TLSSocket.onConnectEnd (node:internal/tls/wrap:1820:19)\\n    at TLSSocket.emit (node:events:521:24)";
        throw e;
      }, 10);
      setTimeout(() => { console.log("STILL_ALIVE"); process.exit(0); }, 150);
    `);
    assert.strictEqual(r.code, 0, `exit ${r.code}: ${r.out}`);
    assert.ok(r.out.includes("swallowed transient network"), `no swallow log: ${r.out}`);
    assert.ok(r.out.includes("STILL_ALIVE"), `process died: ${r.out}`);
  }),

  test("swallow cap: >10 transient errors in 60s window becomes fatal", async () => {
    const r = await runChild(`
      ${GUARD}
      let n = 0;
      const timer = setInterval(() => {
        const e = new Error("read ECONNRESET");
        e.stack = "Error: read ECONNRESET\\n    at (/x/node_modules/ws/lib/websocket.js:1:1)";
        throw e; // uncaughtException — guard must swallow the first 10
      }, 20);
      setTimeout(() => { console.log("NO_FATAL"); process.exit(0); }, 600);
    `);
    // 20ms interval over 600ms ≈ 30 throws → cap exceeded → exit 1
    assert.strictEqual(r.code, 1, `expected fatal after cap, got exit ${r.code}: ${r.out}`);
    assert.ok(r.out.includes("transient errors in"), `no cap log: ${r.out}`);
  }),

  test("installCrashGuard is idempotent (double install ok)", async () => {
    const r = await runChild(`
      ${GUARD}
      import("process").then(() => {});
      setTimeout(() => { console.log("TWO_INSTALLS_OK"); process.exit(0); }, 20);
    `.replace("installCrashGuard({ log: (m) => console.log(m) });",
      `installCrashGuard({ log: () => {} }); installCrashGuard({ log: () => {} });`));
    assert.strictEqual(r.code, 0, `exit ${r.code}: ${r.out}`);
    assert.ok(r.out.includes("TWO_INSTALLS_OK"), `died: ${r.out}`);
  }),
]);

function out(r) {
  return r.out;
}

results.forEach((l) => console.log(l));
console.log(results.some((l) => l.startsWith("fail")) ? "FAILED" : "all crash-guard tests passed");
