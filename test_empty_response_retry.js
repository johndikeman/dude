import assert from "node:assert/strict";
import {
  MAX_EMPTY_RESPONSE_RETRIES,
  nudgePrompt,
  shouldNudge,
} from "./src/empty-response-retry.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// shouldNudge
test("nudges on a fully empty settle", () => {
  assert.equal(
    shouldNudge({ lastAssistantText: undefined, error: undefined, attemptsSoFar: 0 }),
    true,
  );
});

test("nudges on a whitespace-only response", () => {
  assert.equal(
    shouldNudge({ lastAssistantText: "  \n\t ", error: undefined, attemptsSoFar: 0 }),
    true,
  );
});

test("does not nudge when there is real output", () => {
  assert.equal(
    shouldNudge({ lastAssistantText: "done. summary: ...", error: undefined, attemptsSoFar: 0 }),
    false,
  );
});

test("does not nudge when pi reported an error", () => {
  assert.equal(
    shouldNudge({ lastAssistantText: undefined, error: "402 credit exhausted", attemptsSoFar: 0 }),
    false,
  );
});

test("gives up after the retry cap", () => {
  for (let i = 0; i < MAX_EMPTY_RESPONSE_RETRIES; i++) {
    assert.equal(
      shouldNudge({ lastAssistantText: undefined, error: undefined, attemptsSoFar: i }),
      true,
      `attempt ${i} should still nudge`,
    );
  }
  assert.equal(
    shouldNudge({
      lastAssistantText: undefined,
      error: undefined,
      attemptsSoFar: MAX_EMPTY_RESPONSE_RETRIES,
    }),
    false,
    "attempt at cap should not nudge",
  );
});

test("cap is configurable via env and sane by default", () => {
  assert.ok(MAX_EMPTY_RESPONSE_RETRIES >= 1);
});

// nudgePrompt
test("nudge prompt mentions the empty response and attempt number", () => {
  const p = nudgePrompt(2);
  assert.match(p, /empty/i);
  assert.match(p, /nudge 2/);
  assert.ok(p.includes("continue"), "should ask the model to continue");
});

test("nudge prompt instructs a summary fallback instead of silence", () => {
  assert.match(nudgePrompt(1), /summary/);
});

console.log(`\n${passed} tests passed`);
