// tests for src/typing.js
import assert from "node:assert";
import { startTypingLoop, TYPING_REFRESH_INTERVAL_MS } from "./src/typing.js";

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
  test("calls sendTyping immediately and on interval", async () => {
    let calls = 0;
    const channel = { sendTyping: () => { calls++; return Promise.resolve(); } };
    const stop = startTypingLoop(channel, {
      intervalMs: 30,
      log: () => {},
    });
    await new Promise((r) => setTimeout(r, 100));
    stop();
    // immediate call + several interval refreshes
    assert.ok(calls >= 2, `expected >= 2 calls, got ${calls}`);
    await new Promise((r) => setTimeout(r, 60));
    const afterStop = calls;
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(calls, afterStop, "no calls after stop()");
  }),

  test("stop() is idempotent", async () => {
    const channel = { sendTyping: () => Promise.resolve() };
    const stop = startTypingLoop(channel, { log: () => {} });
    stop();
    stop(); // should not throw
  }),

  test("handles invalid channel gracefully", async () => {
    const logs = [];
    const stop = startTypingLoop(null, { log: (m) => logs.push(m) });
    stop();
    const stop2 = startTypingLoop({}, { log: (m) => logs.push(m) });
    stop2();
    assert.strictEqual(logs.length, 2, "should log a skip message for each invalid channel");
  }),

  test("sendTyping rejection does not break the loop", async () => {
    let calls = 0;
    const channel = {
      sendTyping: () => {
        calls++;
        if (calls === 1) return Promise.reject(new Error("rate limited"));
        return Promise.resolve();
      },
    };
    const logs = [];
    const stop = startTypingLoop(channel, {
      intervalMs: 20,
      log: (m) => logs.push(m),
    });
    await new Promise((r) => setTimeout(r, 70));
    stop();
    assert.ok(calls >= 2, "loop continued after a rejected sendTyping");
    assert.ok(logs.some((l) => l.includes("rate limited")), "failure was logged");
  }),

  test("refresh interval is under discord's ~10s typing expiry", () => {
    assert.ok(TYPING_REFRESH_INTERVAL_MS < 10000);
    assert.strictEqual(TYPING_REFRESH_INTERVAL_MS, 8000);
  }),
]);

console.log(results.join("\n"));
