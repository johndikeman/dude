// tests for src/notify.js — discord pings for non-discord-triggered runs
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  startedMessage,
  finishedMessage,
  resolveNotifyChannelId,
  sendNotify,
} from "./src/notify.js";

const results = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push(`ok - ${name}`);
    })
    .catch((e) => {
      console.error(`fail - ${name}: ${e?.message || e}`);
      process.exitCode = 1;
    });
}

await Promise.all([
  test("startedMessage includes trigger, purpose and context", () => {
    const msg = startedMessage({
      trigger: "scheduled cron run",
      purpose: "prediction-markets",
      context: { summary: "hourly cycle" },
    });
    assert.ok(msg.startsWith("▶️ dude run starting"));
    assert.ok(msg.includes("scheduled cron run"));
    assert.ok(msg.includes("purpose: prediction-markets"));
    assert.ok(msg.includes("hourly cycle"));
  }),

  test("startedMessage handles missing purpose/context", () => {
    const msg = startedMessage({ trigger: "wait-fired run" });
    assert.ok(msg.startsWith("▶️ dude run starting (wait-fired run)"));
    assert.ok(!msg.includes("purpose:"));
  }),

  test("finishedMessage ok outcome with summary", () => {
    const msg = finishedMessage({
      outcome: "ok",
      summary: "shipped the thing",
    });
    assert.ok(msg.startsWith("✅ dude run finished"));
    assert.ok(msg.includes("shipped the thing"));
  }),

  test("finishedMessage failed outcome includes truncated error", () => {
    const msg = finishedMessage({
      outcome: "failed",
      err: "x".repeat(2000),
    });
    assert.ok(msg.startsWith("❌ dude run failed"));
    assert.ok(msg.includes("error: "));
    // error truncated to 600
    assert.ok(!msg.includes("x".repeat(700)));
  }),

  test("finishedMessage long summary truncated to fit discord cap", () => {
    const msg = finishedMessage({
      outcome: "ok",
      summary: "y".repeat(5000),
      sessionFile: "/tmp/some-session.jsonl",
    });
    assert.ok(msg.length <= 1900, "message must fit discord's 2000-char cap with margin");
    // session line survives, summary fills the remaining budget
    assert.ok(msg.includes("/tmp/some-session.jsonl"));
    assert.ok(msg.includes("y".repeat(100)));
  }),

  test("finishedMessage loop-abort outcome", () => {
    const msg = finishedMessage({ outcome: "loop-abort" });
    assert.ok(msg.startsWith("🛑 dude run aborted"));
  }),

  test("resolveNotifyChannelId env var priority + cleanup (serialized)", () => {
    process.env.DUDE_NOTIFY_CHANNEL_ID = "chan-env";
    assert.strictEqual(resolveNotifyChannelId(), "chan-env");
    delete process.env.DUDE_NOTIFY_CHANNEL_ID;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dude-notify-"));
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ lastChannelId: "chan-cfg" }),
    );
    assert.strictEqual(resolveNotifyChannelId({ configDir: dir }), "chan-cfg");
    // missing file -> null
    assert.strictEqual(resolveNotifyChannelId({ configDir: "/nonexistent" }), null);
  }),

  test("sendNotify skips when no channel id", async () => {
    const old = process.env.DUDE_NOTIFY_CHANNEL_ID;
    delete process.env.DUDE_NOTIFY_CHANNEL_ID;
    const logs = [];
    const sent = await sendNotify({
      content: "hello",
      paths: { configDir: "/nonexistent" },
      log: (m) => logs.push(m),
    });
    assert.strictEqual(sent, null);
    assert.ok(logs.some((m) => m.includes("no channel id")));
    if (old) process.env.DUDE_NOTIFY_CHANNEL_ID = old;
  }),

  test("sendNotify skips when no DISCORD_TOKEN (lazy client path)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dude-notify-"));
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ lastChannelId: "chan-cfg" }),
    );
    const old = process.env.DISCORD_TOKEN;
    delete process.env.DISCORD_TOKEN;
    const logs = [];
    const sent = await sendNotify({
      content: "hello",
      paths: { configDir: dir },
      log: (m) => logs.push(m),
    });
    assert.strictEqual(sent, null);
    assert.ok(logs.some((m) => m.includes("no DISCORD_TOKEN")));
    if (old) process.env.DISCORD_TOKEN = old;
  }),

  test("sendNotify fast path uses an already-logged-in client", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dude-notify-"));
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ lastChannelId: "chan-cfg" }),
    );
    const sends = [];
    const fakeClient = {
      user: {}, // "logged in"
      channels: {
        fetch: async (id) => ({
          id,
          send: async (content) => sends.push([id, content]),
        }),
      },
    };
    const sent = await sendNotify({
      existingClient: fakeClient,
      content: "fast path ping",
      paths: { configDir: dir },
    });
    assert.ok(sent);
    assert.deepStrictEqual(sends, [["chan-cfg", "fast path ping"]]);
  }),
]);

console.log(`\n${results.length} notify tests finished`);
