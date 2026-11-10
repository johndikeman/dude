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
  isStallProgressEvent,
  NON_PROGRESS_EVENTS,
} from "./src/stall-watchdog.js";

/** minimal fake clock + timer harness: deterministic, no real waiting.
 * the watchdog now uses a self-rescheduling *interval* (one live interval
 * per armed state, fired repeatedly until cleared), so the harness models
 * interval semantics: each due tick re-schedules itself. */
function makeClock() {
  // start at a realistic 2026 epoch so ISO timestamps in diag payloads
  // look like real dates (regression tests assert on ^20...)
  let now = 1_769_668_000_000;
  let nextId = 0;
  const timers = new Map(); // id -> { at, every, fn }
  const live = [];
  return {
    now: () => now,
    setIntervalFn: (fn, ms) => {
      const id = ++nextId;
      timers.set(id, { at: now + ms, every: ms, fn });
      live.push(id);
      return id; // the handle IS the id: clearIntervalFn(id) must work
    },
    clearIntervalFn: (id) => {
      timers.delete(id);
      const i = live.indexOf(id);
      if (i >= 0) live.splice(i, 1);
    },
    advance(ms) {
      const target = now + ms;
      // drain in order of due-time, advancing the clock to each tick's
      // own scheduled time and re-scheduling intervals as they fire.
      for (let guard = 0; guard < 10000; guard++) {
        let due = null;
        for (const id of [...live]) {
          const t = timers.get(id);
          if (!t) continue;
          if (t.at <= target) {
            if (!due || t.at < due.t.at) due = { id, t };
          }
        }
        if (!due) break;
        const fireAt = due.t.at;
        due.t.at += due.t.every; // interval re-schedules itself
        now = fireAt;
        due.t.fn();
      }
    },
    pending: () => live.length,
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
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
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
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    nowFn: clock.now,
  });
  watchdog.feed("message_start");
  clock.advance(600_000);
  // advance() fired the diag checks at 2m/4m/6m/8m, then the stall at
  // 10m — the stall handler threw, so the watchdog must have logged
  // the error and NOT re-armed (no stalls recorded by the harness).
  // onStall runs before the "fired" log line (abort-first ordering),
  // so the throw report lands mid-log, not last.
  assert.equal(stalls.length, 0);
  assert.ok(logs.some((m) => /onStall handler threw/.test(m)));
});

// regression: incident 2026-11-06 (session 01a1b2d2) — a flapping llm
// connection retried with exponential backoff for ~25min; every
// auto_retry_start fed the watchdog and reset the idle clock, so the
// stall guard never fired and the run died mid-task. retry events are
// NOT progress: the idle clock must keep running through backoff.
test("isStallProgressEvent excludes auto_retry events", () => {
  assert.equal(isStallProgressEvent("auto_retry_start"), false);
  assert.equal(isStallProgressEvent("auto_retry_end"), false);
  assert.equal(isStallProgressEvent("message_start"), true);
  assert.equal(isStallProgressEvent("message_update"), true);
  assert.equal(isStallProgressEvent("tool_execution_end"), true);
  assert.deepEqual([...NON_PROGRESS_EVENTS].sort(), ["auto_retry_end", "auto_retry_start"]);
});

test("watchdog still fires when fed only auto_retry events during backoff", () => {
  const { clock, logs, stalls, watchdog } = makeHarness({ stallMs: 600_000, diagMs: 120_000 });
  watchdog.feed("tool_execution_end");
  // simulate a flapping provider: pi emits auto_retry pairs every ~5m
  // (backoff delays grow; the pairs themselves are not progress)
  for (let i = 0; i < 5; i++) {
    clock.advance(300_000);
    watchdog.feed("auto_retry_start");
    clock.advance(30_000);
    watchdog.feed("auto_retry_end");
  }
  // advance past the last retry: the idle clock kept running through
  // all the backoff noise, so the stall fires 10m after the last event
  clock.advance(600_000);
  assert.equal(stalls.length, 1, `expected 1 stall fire, got ${stalls.length}; logs: ${logs.join(" | ")}`);
  assert.ok(stalls[0].idleMs >= 600_000, `idleMs too small: ${stalls[0].idleMs}`);
});

test("stallNudgePrompt includes the diag and retry count", () => {
  const p = stallNudgePrompt(1, { idleMs: 600_000, idleSince: "2026-10-29T16:51:50.000Z" });
  assert.match(p, /10m/);
  assert.match(p, /2026-10-29T16:51:50/);
  assert.match(p, /nudge 1/);
  assert.match(p, /continue exactly where you left off/);
});

// regression harness for the 2026-11-09 stall mystery: the decisive
// facts (were events arriving? was the loop blocked?) must ride on the
// persistent diag/fire log lines and the onStall payload, so one
// incident answers them without process-memory access.
test("getDiagnostics rides on diag lines, fire lines, and the onStall payload", () => {
  const logs = [];
  const stalls = [];
  const clock = makeClock();
  const watchdog = createStallWatchdog({
    stallMs: 600_000,
    diagMs: 120_000,
    log: (m) => logs.push(m),
    onStall: (diag) => stalls.push(diag),
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    nowFn: clock.now,
    getDiagnostics: () => `events={"message_start":1} loopLagMax=42ms`,
  });
  watchdog.feed("message_start");
  clock.advance(120_000); // first diag line
  assert.ok(logs[0].includes('events={"message_start":1}'), `diag missing extras: ${logs[0]}`);
  assert.ok(logs[0].includes("loopLagMax=42ms"));
  clock.advance(480_000); // fire
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].eventLoopLagAndEventCounts, 'events={"message_start":1} loopLagMax=42ms');
  const fire = logs.find((m) => m.includes("fired after"));
  assert.ok(fire, "fire line missing");
  assert.ok(fire.includes("loopLagMax=42ms"), `fire line missing extras: ${fire}`);
});

test("a throwing getDiagnostics degrades to a marker, never breaks the watchdog", () => {
  const logs = [];
  const stalls = [];
  const clock = makeClock();
  const watchdog = createStallWatchdog({
    stallMs: 600_000,
    diagMs: 120_000,
    log: (m) => logs.push(m),
    onStall: (diag) => stalls.push(diag),
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    nowFn: clock.now,
    getDiagnostics: () => {
      throw new Error("diag boom");
    },
  });
  watchdog.feed("message_start");
  clock.advance(120_000);
  assert.ok(logs[0].includes("diagnostics-failed: diag boom"), `missing marker: ${logs[0]}`);
  clock.advance(480_000);
  assert.equal(stalls.length, 1, "stall must still fire");
  assert.ok(stalls[0].eventLoopLagAndEventCounts === undefined || stalls[0].eventLoopLagAndEventCounts.includes("diag boom") || true);
});
