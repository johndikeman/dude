// tests for pi-langfuse-traces auto-enqueue: on session_shutdown the session's
// trace must be POSTed to the "session-review" annotation queue (john's
// enqueue-all decision). the trace ingest is async, so enqueue must retry on
// 404 until langfuse knows the trace.
import assert from "assert";
import http from "node:http";
import { pathToFileURL } from "node:url";

// fake langfuse: records requests, lets each test script responses
let server;
let port;
let requests = [];
let respond;

async function startServer() {
  requests = [];
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r = respond({ method: req.method, url: req.url, body });
      requests.push({ method: req.method, url: req.url, body });
      res.statusCode = r.status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(r.json ?? {}));
    });
  });
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  port = server.address().port;
}

// fresh module per test: node's ts loader dedupes by path even with query
// strings, so copy the source to a unique temp file per import
import fs from "node:fs";
import os from "node:os";
let importCount = 0;
const SRC = fs.readFileSync(new URL("./src/langfuse/pi-langfuse-traces.ts", import.meta.url), "utf8");
async function freshImport() {
  const dir = fs.mkdtempSync(os.tmpdir() + "/lf-ext-");
  const f = `${dir}/ext-${++importCount}.ts`;
  fs.writeFileSync(f, SRC);
  return import(pathToFileURL(f).href);
}

function fakePi() {
  const handlers = {};
  return {
    on: (ev, fn) => {
      handlers[ev] = fn;
    },
    handlers,
  };
}

// run one session against the fake langfuse (no-op handlers when inert)
async function runSession(extMod) {
  const pi = fakePi();
  extMod.default(pi);
  await pi.handlers.session_start?.();
  await pi.handlers.turn_end?.({
    message: { role: "assistant", model: "test-model", provider: "test", content: "ok" },
  });
  await pi.handlers.session_shutdown?.();
}

const LANGFUSE_ENV_KEYS = ["LANGFUSE_HOST", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_AUTO_ENQUEUE", "LANGFUSE_QUEUE_NAME"];
async function withEnv(env, fn) {
  const saved = {};
  for (const k of LANGFUSE_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, env);
  try {
    await fn();
  } finally {
    for (const k of LANGFUSE_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. enqueue-all: shutdown POSTs {objectType: TRACE, objectId: <base64 16-byte id>}
//    with retries through two 404s until accepted.
{
  await startServer();
  await withEnv({ LANGFUSE_HOST: `http://127.0.0.1:${port}`, LANGFUSE_PUBLIC_KEY: "pk-test", LANGFUSE_SECRET_KEY: "sk-test" }, async () => {
    let items404s = 2; // fail twice, then accept
    respond = ({ method, url }) => {
      if (method === "GET" && url === "/api/public/annotation-queues")
        return { status: 200, json: { data: [{ id: "Q1", name: "session-review" }] } };
      if (method === "POST" && url === "/api/public/annotation-queues/Q1/items") {
        if (items404s-- > 0) return { status: 404, json: { error: "not yet" } };
        return { status: 201, json: { id: "item1", status: "PENDING" } };
      }
      if (method === "POST" && url === "/api/public/otel/v1/traces") return { status: 200, json: {} };
      return { status: 500, json: {} };
    };

    await runSession(await freshImport());
    // retries: 1s + 2s + margin
    await sleep(3600);

    const items = requests.filter((r) => r.url.includes("/items"));
    console.error("DEBUG case1 requests:", JSON.stringify(requests.map(r=>r.method+" "+r.url)));
    assert.strictEqual(items.length, 3, `expected 2 failed + 1 ok enqueue, got ${items.length}`);
    const ok = JSON.parse(items[items.length - 1].body);
    assert.strictEqual(ok.objectType, "TRACE");
    const decoded = Buffer.from(ok.objectId, "base64").toString("hex");
    assert.strictEqual(decoded.length, 32, "trace id must be a 16-byte id in base64 form");
  });
}

// 2. queue missing → lookup only, no enqueue calls, no crash
{
  await startServer();
  await withEnv({ LANGFUSE_HOST: `http://127.0.0.1:${port}`, LANGFUSE_PUBLIC_KEY: "pk-test", LANGFUSE_SECRET_KEY: "sk-test" }, async () => {
    respond = ({ method, url }) => {
      if (method === "GET" && url === "/api/public/annotation-queues") return { status: 200, json: { data: [] } };
      if (method === "POST" && url === "/api/public/otel/v1/traces") return { status: 200, json: {} };
      return { status: 500, json: {} };
    };
    await runSession(await freshImport());
    await sleep(2500);
    assert.ok(!requests.some((r) => r.url.includes("/items")), "no enqueue when queue doesn't exist");
  });
}

// 3. LANGFUSE_AUTO_ENQUEUE=off → no queue traffic at all
{
  await startServer();
  await withEnv({ LANGFUSE_HOST: `http://127.0.0.1:${port}`, LANGFUSE_PUBLIC_KEY: "pk-test", LANGFUSE_SECRET_KEY: "sk-test", LANGFUSE_AUTO_ENQUEUE: "off" }, async () => {
    respond = () => ({ status: 200, json: {} });
    await runSession(await freshImport());
    await sleep(200);
    assert.ok(!requests.some((r) => r.url.includes("annotation-queues")), "no queue traffic when disabled");
  });
}

// 4. inert without credentials (other machines unaffected)
{
  await startServer();
  await withEnv({}, async () => {
    respond = () => ({ status: 200, json: {} });
    await runSession(await freshImport());
    assert.strictEqual(requests.length, 0, "no requests without env config");
  });
}

server?.close();
// keep-alive agent sockets keep the loop alive; exit explicitly on success
console.log("test_langfuse_enqueue: all ok");
process.exit(0);
