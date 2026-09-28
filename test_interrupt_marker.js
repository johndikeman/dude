// tests for appendSessionMarker (interrupted.js): tries the pi API
// spellings in order and falls across versions instead of failing hard.
import { appendSessionMarker } from "./src/interrupted.js";
import assert from "assert";

// spelling 1: appendEntry (pi 0.84.x)
{
  const calls = [];
  const session = { appendEntry: (t, d) => calls.push([t, d]) };
  appendSessionMarker(session, "interrupted", { reason: "SIGTERM" });
  assert.deepStrictEqual(calls, [["interrupted", { reason: "SIGTERM" }]]);
}

// spelling 2: appendCustomEntry (older builds)
{
  const calls = [];
  const session = { appendCustomEntry: (t, d) => calls.push([t, d]) };
  appendSessionMarker(session, "interrupted", { x: 1 });
  assert.deepStrictEqual(calls, [["interrupted", { x: 1 }]]);
}

// spelling 3: sessionManager.appendCustomEntry
{
  const calls = [];
  const session = { sessionManager: { appendCustomEntry: (t, d) => calls.push([t, d]) } };
  appendSessionMarker(session, "interrupted", { x: 2 });
  assert.deepStrictEqual(calls, [["interrupted", { x: 2 }]]);
}

// none present -> throws (caller logs it, non-fatal)
{
  assert.throws(() => appendSessionMarker({}, "interrupted", {}));
}

// appendEntry exists but throws -> falls back to appendCustomEntry
{
  const calls = [];
  const session = {
    appendEntry: () => { throw new Error("old signature broken"); },
    appendCustomEntry: (t, d) => calls.push([t, d]),
  };
  appendSessionMarker(session, "interrupted", { y: 3 });
  assert.deepStrictEqual(calls, [["interrupted", { y: 3 }]]);
}

console.log("test_interrupt_marker.js: all ok");
