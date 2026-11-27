/**
 * tests for src/runtime-cap.js — the wall-clock cap for agent runs.
 *
 * incident 2026-09-24: a wait-fired run held the agent lock for 13h3m
 * (anti-bot cooloff loops) and starved every scheduled dude cycle. the
 * cap must abort the session at the soft cap and hard-kill after grace.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAX_RUNTIME_MS,
  RUNTIME_CAP_EXIT_CODE,
  maxRuntimeMs,
  startRuntimeCap,
} from "./src/runtime-cap.js";

/** minimal fake timer harness: no real time passes, we control ticks */
function fakeTimers() {
  const timers = [];
  let id = 0;
  return {
    setTimeoutFn(fn, ms) {
      const t = { id: ++id, fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeoutFn(t) {
      t.cleared = true;
    },
    tick(ms) {
      for (const t of timers.filter((t) => !t.cleared && t.ms <= ms)) t.fn();
    },
    timers,
  };
}

function silence() {
  const lines = [];
  return { log: (m) => lines.push(String(m)), lines };
}

test("maxRuntimeMs: default when env unset, override when set, 0 disables", () => {
  assert.equal(maxRuntimeMs({}), DEFAULT_MAX_RUNTIME_MS);
  assert.equal(maxRuntimeMs({ DUDE_MAX_RUNTIME_MS: "5000" }), 5000);
  assert.equal(maxRuntimeMs({ DUDE_MAX_RUNTIME_MS: "0" }), 0);
  assert.equal(maxRuntimeMs({ DUDE_MAX_RUNTIME_MS: "nonsense" }), DEFAULT_MAX_RUNTIME_MS);
  // negative clamps to 0 (disabled), not negative
  assert.equal(maxRuntimeMs({ DUDE_MAX_RUNTIME_MS: "-5" }), 0);
});

test("cap fires at ms: logs, aborts session, arms hard kill", () => {
  const t = fakeTimers();
  const { log, lines } = silence();
  const aborted = [];
  const released = [];
  const exits = [];
  const stop = startRuntimeCap({
    ms: 1000,
    log,
    session: { abort: () => aborted.push(1) },
    releaseFn: () => released.push(1),
    exitFn: (code) => exits.push(code),
    hardKillGraceMs: 500,
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
  });

  t.tick(999);
  assert.equal(aborted.length, 0, "no abort before cap");

  t.tick(1000);
  assert.equal(aborted.length, 1, "session aborted at soft cap");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /runtime cap exceeded/);

  // grace elapsed -> hard kill with exit 124 and lock released
  t.tick(1500);
  assert.equal(released.length, 1);
  assert.deepEqual(exits, [RUNTIME_CAP_EXIT_CODE]);
});

test("stop() before cap: nothing fires, nothing armed", () => {
  const t = fakeTimers();
  const { log } = silence();
  const exits = [];
  const stop = startRuntimeCap({
    ms: 1000,
    log,
    exitFn: (c) => exits.push(c),
    hardKillGraceMs: 10,
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
  });
  stop();
  t.tick(2000);
  assert.deepEqual(exits, []);
});

test("stop() after abort but before hard kill cancels the hard kill", () => {
  const t = fakeTimers();
  const { log } = silence();
  const exits = [];
  const stop = startRuntimeCap({
    ms: 1000,
    log,
    exitFn: (c) => exits.push(c),
    hardKillGraceMs: 500,
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
  });
  t.tick(1000); // abort fires, hard kill armed
  const issued = stop(); // run settled before the hard kill
  assert.equal(issued, true, "stop() reports the cap had fired");
  t.tick(2000);
  assert.deepEqual(exits, [], "hard kill cancelled by clean settle");
});

test("run ending normally stops the cap before it fires", () => {
  const t = fakeTimers();
  const { log } = silence();
  const exits = [];
  const stop = startRuntimeCap({
    ms: 1000,
    log,
    exitFn: (c) => exits.push(c),
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
  });
  t.tick(999);
  stop(); // run finished normally
  t.tick(2000);
  assert.deepEqual(exits, []);
});

test("ms <= 0 disables the cap entirely (no timers)", () => {
  const t = fakeTimers();
  const { log } = silence();
  const exits = [];
  const stop = startRuntimeCap({
    ms: 0,
    log,
    exitFn: (c) => exits.push(c),
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
  });
  t.tick(999999);
  assert.deepEqual(exits, []);
  assert.equal(stop(), false, "stop reports cap never fired");
  assert.deepEqual(t.timers, [], "no timers armed");
});

test("cap survives a session.abort() that throws synchronously", () => {
  const t = fakeTimers();
  const { log, lines } = silence();
  const exits = [];
  startRuntimeCap({
    ms: 1000,
    log,
    session: { abort: () => { throw new Error("abort boom"); } },
    exitFn: (c) => exits.push(c),
    hardKillGraceMs: 100,
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
  });
  t.tick(1000);
  t.tick(1500);
  assert.match(lines[0], /runtime cap exceeded/);
  assert.deepEqual(exits, [RUNTIME_CAP_EXIT_CODE], "hard kill still happens");
});
/* ------------------------------------------------------------------ */
/* per-run cap selection: stage runs get the longer cap                */
/* ------------------------------------------------------------------ */

import { runtimeCapMsForRun, DEFAULT_STAGE_MAX_RUNTIME_MS } from "./src/runtime-cap.js";

test("runtimeCapMsForRun: regular runs keep the 4h default", () => {
  assert.equal(runtimeCapMsForRun([]), DEFAULT_MAX_RUNTIME_MS);
  assert.equal(runtimeCapMsForRun(["--purpose", "eng-orchestrator"]), DEFAULT_MAX_RUNTIME_MS);
  assert.equal(runtimeCapMsForRun(["--once", "--purpose", "prediction-markets", "--context", "project=x"]), DEFAULT_MAX_RUNTIME_MS);
});

test("runtimeCapMsForRun: eng stage runs get the stage cap (12h) minus the hard-kill grace", () => {
  const args = ["--once", "--purpose", "eng-orchestrator", "--context", "project=offgridusb-2.0 stage=implement"];
  const expected = DEFAULT_STAGE_MAX_RUNTIME_MS - 60 * 1000;
  assert.equal(runtimeCapMsForRun(args), expected);
  // unit cap (systemd RuntimeMaxSec) must stay larger than the in-agent cap
  assert.ok(expected < DEFAULT_STAGE_MAX_RUNTIME_MS);
});

test("runtimeCapMsForRun: stage cap is env-overridable and 0 disables", () => {
  const args = ["--purpose", "eng-orchestrator", "--context", "stage=test"];
  const saved = process.env.DUDE_STAGE_MAX_RUNTIME_MS;
  try {
    process.env.DUDE_STAGE_MAX_RUNTIME_MS = "1800000"; // 30m
    assert.equal(runtimeCapMsForRun(args), 1800000 - 60 * 1000);
    process.env.DUDE_STAGE_MAX_RUNTIME_MS = "0";
    assert.equal(runtimeCapMsForRun(args), 0); // cap disabled
  } finally {
    if (saved === undefined) delete process.env.DUDE_STAGE_MAX_RUNTIME_MS;
    else process.env.DUDE_STAGE_MAX_RUNTIME_MS = saved;
  }
});
