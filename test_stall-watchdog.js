/**
 * tests for the llm-stall watchdog (src/stall-watchdog.js).
 *
 * regression: session 01a1888d (2026-10-29) — the llm backend silently
 * hung a request for 41 minutes after a tool result (no streaming, no
 * settle, no error) and the harness only noticed at SIGTERM time. the
 * watchdog must fire on real stalls, stay quiet while a tool runs, and
 * produce a diagnostic payload rich enough to debug future stalls.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_STALL_MS,
  DEFAULT_DIAG_MS,
  maxStallRetries,
  stallMs,
  diagMs,
  createStallWatchdog,
  stallNudgePrompt,
} from "./src/stall-watchdog.js";

/** minimal fake clock + timer harness: deterministic, no real waiting */
function makeClock() {
  // start at a realistic 2026 epoch so ISO timestamps in diag payloads
  // look like real dates (regression tests assert on ^20...)
  let now = 1_769_668_000_000;
  let nextId = 0;
  const timers = new Map(); // id -> { at, fn }
  const timeouts = [];
  return {
    now: () => now,
    setTimeoutFn: (fn, ms) => {
      const id = ++nextId;
      const at = now + ms;
      timers.set(id, { at, fn });
      timeouts.push(id);
      return id; // the handle IS the id: clearTimeoutFn(id) must work
    },
    clearTimeoutFn: (id) => {
      timers.delete(id);
      const i = timeouts.indexOf(id);
      if (i >= 0) timeouts.splice(i, 1);
    },
    advance(ms) {
      const target = now + ms;
      // drain in order of due-time, advancing the clock to each timer's
      // own scheduled time (so "now" is always the moment the callback
      // should run) — the watchdog re-schedules itself during check(),
      // and follow-up timers must fire inside the same advance().
      for (let guard = 0; guard < 1000; guard++) {
        let due = null;
        for (const id of [...timeouts]) {
          const t = timers.get(id);
          if (!t) continue;
          if (t.at <= target) {
            if (!due || t.at < due.t.at) due = { id, t };
          }
        }
        if (!due) break;
        timers.delete(due.id);
        const i = timeouts.indexOf(due.id);
        if (i >= 0) timeouts.splice(i, 1);
        now = due.t.at;
        due.t.fn();
      }
    },
    pending: () => timeouts.length,
  };
}

function makeHarness({ stallMs: s, diagMs: d } = {}) {
  const clock = makeClock();
  const logs = [];
  const stalls = [];
  const watchdog = createStallWatchdog({
    stallMs: s,
    diagMs: d,
    log: (m) => logs.push(m),
    onStall: (diag) => stalls.push(diag),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    nowFn: clock.now,
  });
  return { clock, logs, stalls, watchdog };
}

// regression: schedule() clears the previous timer by handle; if a
// fake timer harness ignores the handle, the old timer keeps firing
// alongside the new one and stalls multiply — this test proves the
// watchdog only ever has one timer in flight per state.
test("clearTimeout by handle actually cancels the old timer", () => {
  const { clock, stalls, watchdog } = makeHarness({ stallMs: 600_000, diagMs: 120_000 });
  watchdog.feed("message_start");
  clock.advance(300_000);
  watchdog.feed("message_update"); // re-schedule: must clear the old timer
  clock.advance(300_000);
  assert.equal(clock.pending() <= 1, true, `expected at most 1 pending timer, got ${clock.pending()}`);
  assert.equal(stalls.length, 0);
});

test("defaults: stall 10m, diag 2m, retries 2", () => {
  assert.equal(DEFAULT_STALL_MS, 600_000);
  assert.equal(DEFAULT_DIAG_MS, 120_000);
  assert.equal(stallMs({}), 600_000);
  assert.equal(stallMs({ DUDE_LLM_STALL_MS: "300000" }), 300_000);
  assert.equal(stallMs({ DUDE_LLM_STALL_MS: "garbage" }), 600_000);
  assert.equal(stallMs({ DUDE_LLM_STALL_MS: "0" }), 0); // disable
  assert.equal(diagMs({ DUDE_STALL_DIAG_MS: "5000" }), 5000);
  assert.equal(diagMs({ DUDE_STALL_DIAG_MS: "1" }), 1000); // floor
  assert.equal(maxStallRetries({}), 2);
  assert.equal(maxStallRetries({ DUDE_MAX_STALL_RETRIES: "5" }), 5);
  assert.equal(maxStallRetries({ DUDE_MAX_STALL_RETRIES: "x" }), 2);
  assert.equal(maxStallRetries({ DUDE_MAX_STALL_RETRIES: "-1" }), 2);
});

test("fires after idle >= stallMs with a useful diagnostic payload", () => {
  const { clock, logs, stalls, watchdog } = makeHarness({ stallMs: 600_000, diagMs: 120_000 });
  watchdog.feed("message_start");
  clock.advance(120_000); // first diag check: quiet but not stalled
  assert.equal(stalls.length, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /no agent activity for 2m/);
  assert.match(logs[0], /last event: message_start/);
  clock.advance(480_000); // reach the 10m threshold
  assert.equal(stalls.length, 1);
  const diag = stalls[0];
  assert.ok(diag.idleMs >= 600_000);
  assert.equal(diag.lastEventType, "message_start");
  assert.equal(diag.stallCount, 1);
  assert.match(typeof diag.idleSince === "string" ? diag.idleSince : "", /^20/);
  // fires only once; not re-armed after firing
  clock.advance(1_200_000);
  assert.equal(stalls.length, 1);
});

test("activity keeps pushing the stall back", () => {
  const { clock, stalls, watchdog } = makeHarness({ stallMs: 600_000, diagMs: 120_000 });
  // a 5-minute heartbeat between feeds: gaps of 300k < 600k stall
  // threshold, so the stall must never fire
  for (let i = 0; i < 5; i++) {
    clock.advance(300_000);
    watchdog.feed("message_update");
    assert.equal(stalls.length, 0);
  }
  // then 10 minutes of silence → stall fires
  clock.advance(600_000);
  assert.equal(stalls.length, 1);
});

test("long-running tool does not count as a stall", () => {
  const { clock, logs, stalls, watchdog } = makeHarness({ stallMs: 600_000, diagMs: 120_000 });
  watchdog.feed("message_start");
  watchdog.feed("tool_execution_start"); // e.g. a 20-minute bash command
  clock.advance(1_800_000);
  assert.equal(stalls.length, 0, "no stall fire while a tool is active");
  assert.equal(logs.length, 0, "no diag noise while a tool is active");
  watchdog.feed("tool_execution_end");
  clock.advance(600_000);
  assert.equal(stalls.length, 1);
});

test("any event type keeps the watchdog alive, not just tools", () => {
  const { clock, stalls, watchdog } = makeHarness({ stallMs: 600_000, diagMs: 120_000 });
  // john's clarification (2026-10-29): any text response/movement in the
  // session should keep it alive — not just tool calls. pi emits lots of
  // event types (message_start/update/end, agent_start, entry_appended…)
  // and the harness feeds every one of them to the watchdog.
  for (const type of ["agent_start", "message_start", "message_update", "message_end", "entry_appended", "session_info_changed"]) {
    watchdog.feed(type);
    clock.advance(500_000); // 8.3min — would fire if this type weren't counted
    assert.equal(stalls.length, 0, `event type ${type} did not reset the stall clock`);
  }
});

test("tool depth is clamped: an end without a start cannot go negative", () => {
  const { clock, watchdog } = makeHarness({ stallMs: 600_000, diagMs: 120_000 });
  watchdog.feed("tool_execution_end");
  watchdog.feed("tool_execution_end");
  watchdog.feed("message_start");
  clock.advance(600_000);
  assert.equal(watchdog.state().toolDepth, 0);
});

test("reset() re-arms after a stall-abort + re-prompt", () => {
  const { clock, stalls, watchdog } = makeHarness({ stallMs: 600_000, diagMs: 120_000 });
  watchdog.feed("message_start");
  clock.advance(600_000);
  assert.equal(stalls.length, 1);
  watchdog.reset(); // index.js re-prompts the session
  clock.advance(500_000);
  assert.equal(stalls.length, 1);
  clock.advance(600_000);
  assert.equal(stalls.length, 2, "stall fires again after reset + another stall");
  assert.equal(watchdog.state().stallCount, 2);
});

test("stop() cancels the timer; no further fires", () => {
  const { clock, stalls, watchdog } = makeHarness({ stallMs: 600_000, diagMs: 120_000 });
  watchdog.feed("message_start");
  watchdog.stop();
  clock.advance(5_000_000);
  assert.equal(stalls.length, 0);
});

test("stallMs=0 disables the watchdog entirely", () => {
  const { clock, stalls, watchdog } = makeHarness({ stallMs: 0, diagMs: 120_000 });
  watchdog.feed("message_start");
  clock.advance(10_000_000);
  assert.equal(stalls.length, 0);
});

test("a throwing onStall handler doesn't kill the watchdog or the caller", () => {
  const { clock, stalls, logs } = makeHarness({ stallMs: 600_000, diagMs: 120_000 });
  const watchdog = createStallWatchdog({
    stallMs: 600_000,
    diagMs: 120_000,
    log: (m) => logs.push(m),
    onStall: () => {
      throw new Error("boom");
    },
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    nowFn: clock.now,
  });
  watchdog.feed("message_start");
  clock.advance(600_000);
  // advance() fired the diag checks at 2m/4m/6m/8m, then the stall at
  // 10m — the stall handler threw, so the watchdog must have logged
  // the error and NOT re-armed (no stalls recorded by the harness)
  assert.equal(stalls.length, 0);
  assert.ok(logs.length >= 2);
  const last = logs[logs.length - 1];
  assert.match(last, /onStall handler threw/);
});

test("stallNudgePrompt includes the diag and retry count", () => {
  const p = stallNudgePrompt(1, { idleMs: 600_000, idleSince: "2026-10-29T16:51:50.000Z" });
  assert.match(p, /10m/);
  assert.match(p, /2026-10-29T16:51:50/);
  assert.match(p, /nudge 1/);
  assert.match(p, /continue exactly where you left off/);
});
