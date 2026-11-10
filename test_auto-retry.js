/**
 * tests for src/auto-retry.js — provider auto-retry event classification.
 *
 * regression: session 01a1c288 (2026-11-09 22:58) — pi emits
 * auto_retry_end with success:true when a retry RECOVERED (the retried
 * response streams normally and the agent loop continues on its own).
 * dude's handler treated every auto_retry_end as a terminal failure:
 * it logged "pi failed: undefined", tore down the run, and crashed on
 * truncateLine(undefined) inside the discord reply — the crash-guard
 * then exited the whole process (exit 1) and the user never got a
 * reply. the successful retry response's tool call never executed.
 */
import assert from "node:assert/strict";
import { isAutoRetryFailure, retryErrorText } from "./src/auto-retry.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

test("a successful retry is NOT a failure", () => {
  assert.equal(
    isAutoRetryFailure({ type: "auto_retry_end", success: true, attempt: 1 }),
    false,
  );
});

test("an exhausted retry IS a failure", () => {
  assert.equal(
    isAutoRetryFailure({ type: "auto_retry_end", success: false, attempt: 3, finalError: "Upstream idle timeout exceeded" }),
    true,
  );
});

test("unknown/legacy shapes are NOT failures (fail-safe: keep the run alive)", () => {
  // pi always emits an explicit success field; if a future version
  // doesn't, prefer continuing (the stall watchdog still guards) over
  // tearing down the run the way the 2026-11-09 incident did.
  assert.equal(
    isAutoRetryFailure({ type: "auto_retry_end", attempt: 2, finalError: "boom" }),
    false,
  );
  assert.equal(isAutoRetryFailure({ type: "auto_retry_end" }), false);
});

test("non auto_retry_end events are never failures", () => {
  assert.equal(isAutoRetryFailure({ type: "auto_retry_start", attempt: 1 }), false);
  assert.equal(isAutoRetryFailure({ type: "agent_settled" }), false);
  assert.equal(isAutoRetryFailure(null), false);
});

test("retryErrorText passes real errors through", () => {
  assert.equal(retryErrorText("Upstream idle timeout exceeded"), "Upstream idle timeout exceeded");
});

test("retryErrorText never returns undefined (the crash)", () => {
  assert.equal(retryErrorText(undefined), "unknown provider error");
  assert.equal(retryErrorText(null), "unknown provider error");
  assert.equal(retryErrorText(""), "unknown provider error");
});

console.log(`\n${passed} tests passed`);
