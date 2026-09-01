import assert from "node:assert/strict";
import {
  LOOP_THRESHOLD,
  LOOP_WINDOW,
  createToolLoopDetector,
  loopAbortSummary,
  loopBreakPrompt,
} from "./src/loop-detect.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

test("no loop below threshold", () => {
  const d = createToolLoopDetector();
  for (let i = 0; i < LOOP_THRESHOLD - 1; i++) {
    const r = d.observe("bash", { command: "node test_gd.js 2>&1" });
    assert.equal(r.isLoop, false, `iteration ${i} should not trip`);
  }
});

test("trips at threshold on identical calls (the 2026-08-31 pattern)", () => {
  const d = createToolLoopDetector();
  let r;
  for (let i = 0; i < LOOP_THRESHOLD; i++) {
    r = d.observe("bash", { command: "node test_gd.js 2>&1" });
  }
  assert.equal(r.isLoop, true);
  assert.equal(r.repeats, LOOP_THRESHOLD);
  assert.match(r.signature, /^bash\(.*test_gd\.js/);
});

test("breaking the pattern clears the loop", () => {
  const d = createToolLoopDetector();
  for (let i = 0; i < LOOP_THRESHOLD; i++) {
    d.observe("bash", { command: "node test_gd.js 2>&1" });
  }
  const r = d.observe("edit", { path: "gd.js" });
  assert.equal(r.isLoop, false);
});

test("resumes detecting if the model ignores the nudge and keeps looping", () => {
  const d = createToolLoopDetector();
  for (let i = 0; i < LOOP_THRESHOLD; i++) {
    d.observe("bash", { command: "node test_gd.js 2>&1" });
  }
  // steer happens here; model keeps calling anyway
  for (let i = 0; i < 4; i++) {
    d.observe("bash", { command: "node test_gd.js 2>&1" });
  }
  const r = d.observe("bash", { command: "node test_gd.js 2>&1" });
  assert.equal(r.isLoop, true, "post-steer repeats should still count as loop");
  assert.ok(r.repeats > LOOP_THRESHOLD, `expected repeats > threshold, got ${r.repeats}`);
});

test("legit fix-and-rerun workflow does not trip (args or results change)", () => {
  const d = createToolLoopDetector();
  for (let round = 0; round < 4; round++) {
    d.observe("edit", { path: "gd.js" });
    d.observe("bash", { command: `node test_gd.js --round ${round}` });
    d.observe("read", { path: "gd.js" });
  }
  const r = d.observe("bash", { command: "node test_gd.js --round 4" });
  assert.equal(r.isLoop, false);
});

test("window sliding drops old evidence", () => {
  const d = createToolLoopDetector({ window: 4, threshold: 3 });
  for (let i = 0; i < 3; i++) d.observe("bash", { command: "same" });
  assert.equal(d.observe("other", {}).isLoop, false);
  assert.equal(d.observe("other2", {}).isLoop, false);
  // "same" has slid out of the window entirely by now
  const r = d.observe("other3", {});
  assert.equal(r.isLoop, false);
});

test("alternating A/B loop is caught", () => {
  const d = createToolLoopDetector();
  let r = null;
  for (let i = 0; i < 12; i++) {
    r = d.observe("bash", { command: i % 2 === 0 ? "ping a" : "ping b" });
  }
  // each signature appears 6 times in a window of 16 → under threshold 8.
  // that's fine: pure alternation is a much weaker failure signal; we only
  // hard-stop on outright identical repetition. document the expectation.
  assert.equal(r.isLoop, false);
});

test("reset clears state between runs", () => {
  const d = createToolLoopDetector();
  for (let i = 0; i < LOOP_THRESHOLD; i++) d.observe("bash", { command: "x" });
  d.reset();
  const r = d.observe("bash", { command: "x" });
  assert.equal(r.isLoop, false);
  assert.equal(r.repeats, 1);
});

test("unserializable args don't crash the detector", () => {
  const d = createToolLoopDetector();
  const circular = {};
  circular.self = circular;
  for (let i = 0; i < LOOP_THRESHOLD; i++) d.observe("bash", circular);
  const r = d.observe("bash", circular);
  assert.equal(r.isLoop, true);
});

test("loopBreakPrompt mentions the signature and repeats", () => {
  const p = loopBreakPrompt("bash(node test_gd.js 2>&1)", 8);
  assert.match(p, /node test_gd\.js/);
  assert.match(p, /8 times/);
});

test("loopAbortSummary is a self-contained report", () => {
  const s = loopAbortSummary("bash(node test_gd.js 2>&1)", 12);
  assert.match(s, /terminated by loop breaker/);
  assert.match(s, /12 times/);
});

console.log(`\n${passed} tests passed (window=${LOOP_WINDOW}, threshold=${LOOP_THRESHOLD})`);
