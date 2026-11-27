/**
 * tests for the pending-stage dispatch mechanism (src/wait-runner.js)
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  defaultPendingStageFile,
  readPendingStage,
  clearPendingStage,
  stageUnitName,
  dispatchPendingStage,
  defaultLastStageFile,
  readLastStage,
  recordLastStage,
  stageUnitResult,
  redispatchTimedOutStage,
} from "./src/wait-runner.js";

// isolation: point everything the dispatch touches at a temp dir
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pending-stage-"));
const pendingFile = path.join(tmp, "pending-stage.json");
const inertLockDir = path.join(tmp, "agent-lock");
fs.mkdirSync(inertLockDir);
process.env.DUDE_AGENT_LOCK_FILE = path.join(inertLockDir, "agent-lock.json");
process.env.DUDE_PENDING_STAGE_FILE = pendingFile;
process.env.DUDE_CONFIG_DIR = tmp;

test("defaultPendingStageFile lands in the config dir", () => {
  assert.ok(defaultPendingStageFile().endsWith("pending-stage.json"));
});

test("readPendingStage: missing file → null", () => {
  assert.equal(readPendingStage(), null);
});

test("readPendingStage: valid file is parsed and trimmed", () => {
  fs.writeFileSync(pendingFile, JSON.stringify({ project: "offgridusb-parallel", stage: "testing-design" }));
  assert.deepEqual(readPendingStage(), { project: "offgridusb-parallel", stage: "testing-design" });
  fs.writeFileSync(pendingFile, '{"project": "  x ", "stage": "  y "}');
  assert.deepEqual(readPendingStage(), { project: "x", stage: "y" });
});

test("readPendingStage: malformed / missing fields → null", () => {
  fs.writeFileSync(pendingFile, "not json");
  assert.equal(readPendingStage(), null);
  fs.writeFileSync(pendingFile, JSON.stringify({ project: "x" }));
  assert.equal(readPendingStage(), null);
});

test("clearPendingStage removes the file and is idempotent", () => {
  fs.writeFileSync(pendingFile, '{"project":"x","stage":"y"}');
  clearPendingStage();
  assert.equal(fs.existsSync(pendingFile), false);
  clearPendingStage(); // no throw
});

test("stageUnitName sanitizes odd characters into systemd-safe names", () => {
  assert.equal(stageUnitName("a", "gather"), "dude-eng-a-gather");
  assert.equal(stageUnitName("a b", "c/d"), "dude-eng-a-b-c-d");
});

test("dispatchPendingStage: no pending file → null", async () => {
  assert.equal(await dispatchPendingStage({}), null);
});

test("dispatchPendingStage: spawns the detached unit with the right args and clears the file", async () => {
  fs.writeFileSync(pendingFile, JSON.stringify({ project: "offgridusb-parallel", stage: "testing-design" }));
  const spawns = [];
  const spawnFn = (bin, argv) => {
    spawns.push({ bin, argv });
    return {
      stderr: { on: () => {} },
      on: (ev, cb) => { if (ev === "exit") setImmediate(() => cb(0)); },
    };
  };
  const res = await dispatchPendingStage({ spawnFn });
  assert.equal(res.dispatched, true);
  assert.equal(res.unit, "dude-eng-offgridusb-parallel-testing-design");
  assert.equal(fs.existsSync(pendingFile), false);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].bin, "systemd-run");
  const argv = spawns[0].argv;
  assert.ok(argv.includes("--user"));
  assert.ok(argv.includes("--unit=dude-eng-offgridusb-parallel-testing-design"));
  assert.ok(argv.includes("--property=SuccessExitStatus=75"));
  assert.ok(argv.includes("--purpose"));
  assert.ok(argv.includes("eng-orchestrator"));
  assert.ok(argv.includes("--context"));
  const ctx = argv[argv.indexOf("--context") + 1];
  assert.equal(ctx, "project=offgridusb-parallel stage=testing-design");
});

test("dispatchPendingStage: systemd-run failure keeps the pending file for retry", async () => {
  fs.writeFileSync(pendingFile, JSON.stringify({ project: "x", stage: "y" }));
  const spawnFn = (bin, argv) => ({
    stderr: { on: () => {} },
    on: (ev, cb) => { if (ev === "exit") setImmediate(() => cb(1)); },
  });
  const res = await dispatchPendingStage({ spawnFn });
  assert.equal(res.dispatched, false);
  assert.ok(res.error);
  assert.equal(fs.existsSync(pendingFile), true); // kept for retry
  clearPendingStage();
});

test("dispatchPendingStage: skipped when an agent run is in flight", async () => {
  const lockFile = path.join(inertLockDir, "agent-lock.json");
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  fs.writeFileSync(pendingFile, JSON.stringify({ project: "x", stage: "y" }));
  let calls = 0;
  const spawnFn = (bin, argv) => { calls++; throw new Error("should not spawn"); };
  const res = await dispatchPendingStage({ spawnFn });
  assert.equal(res.dispatched, false);
  assert.equal(res.skippedBusy, true);
  assert.equal(fs.existsSync(pendingFile), true); // kept for next tick
  clearPendingStage();
  fs.unlinkSync(lockFile);
});

/* ------------------------------------------------------------------ */
/* per-stage runtime cap plumbing (DUDE_STAGE_MAX_RUNTIME_MS)          */
/* ------------------------------------------------------------------ */

const lastFile = path.join(tmp, "last-stage.json");
process.env.DUDE_LAST_STAGE_FILE = lastFile;

import { defaultRuntimeMaxSec, stageRuntimeMaxSec } from "./src/wait-runner.js";
import { maxRuntimeMs, stageRuntimeMs, DEFAULT_STAGE_MAX_RUNTIME_MS, DEFAULT_HARD_KILL_GRACE_MS } from "./src/runtime-cap.js";

function withEnv(env, fn) {
  const savedStage = process.env.DUDE_STAGE_MAX_RUNTIME_MS;
  if (env === null) delete process.env.DUDE_STAGE_MAX_RUNTIME_MS;
  else process.env.DUDE_STAGE_MAX_RUNTIME_MS = env;
  try { fn(); } finally {
    if (savedStage === undefined) delete process.env.DUDE_STAGE_MAX_RUNTIME_MS;
    else process.env.DUDE_STAGE_MAX_RUNTIME_MS = savedStage;
  }
}

test("stageRuntimeMs: defaults to 12h and is env-overridable", () => {
  withEnv(null, () => {
    assert.equal(stageRuntimeMs(), DEFAULT_STAGE_MAX_RUNTIME_MS);
    assert.equal(stageRuntimeMs(), 12 * 60 * 60 * 1000);
  });
  withEnv("1800000", () => assert.equal(stageRuntimeMs(), 30 * 60 * 1000));
  withEnv("0", () => assert.equal(stageRuntimeMs(), 0)); // 0 disables
});

test("stage cap stays separate from the regular run cap", () => {
  withEnv(null, () => {
    assert.equal(maxRuntimeMs(), 4 * 60 * 60 * 1000);
    assert.ok(stageRuntimeMs() > maxRuntimeMs());
    assert.equal(stageRuntimeMaxSec(), Math.ceil(stageRuntimeMs() / 1000));
    assert.equal(defaultRuntimeMaxSec(), Math.ceil(maxRuntimeMs() / 1000));
  });
  withEnv("0", () => assert.equal(stageRuntimeMaxSec(), null));
});

test("dispatchPendingStage: stage unit gets RuntimeMaxSec from the STAGE cap, not the 4h default", async () => {
  const saved = process.env.DUDE_STAGE_MAX_RUNTIME_MS;
  process.env.DUDE_STAGE_MAX_RUNTIME_MS = "7200000"; // 2h — must show up as 7200s, not 4h's 14400
  try {
    fs.writeFileSync(pendingFile, JSON.stringify({ project: "x", stage: "y" }));
    const spawns = [];
    const spawnFn = (bin, argv) => {
      spawns.push({ bin, argv });
      return { stderr: { on: () => {} }, on: (ev, cb) => { if (ev === "exit") setImmediate(() => cb(0)); } };
    };
    const res = await dispatchPendingStage({ spawnFn });
    assert.equal(res.dispatched, true);
    assert.ok(spawns[0].argv.includes("--property=RuntimeMaxSec=7200"));
    assert.equal(spawns[0].argv.filter((a) => a.startsWith("--property=RuntimeMaxSec")).length, 1);
    clearPendingStage();
  } finally {
    if (saved === undefined) delete process.env.DUDE_STAGE_MAX_RUNTIME_MS;
    else process.env.DUDE_STAGE_MAX_RUNTIME_MS = saved;
  }
});

/* ------------------------------------------------------------------ */
/* last-stage record + timeout-aware re-dispatch                       */
/* ------------------------------------------------------------------ */

test("recordLastStage / readLastStage round-trip", () => {
  recordLastStage({ project: "offgridusb-2.0", stage: "implement", unit: "dude-eng-offgridusb-2.0-implement" }, lastFile);
  const last = readLastStage(lastFile);
  assert.equal(last.project, "offgridusb-2.0");
  assert.equal(last.stage, "implement");
  assert.equal(last.unit, "dude-eng-offgridusb-2.0-implement");
  assert.ok(last.dispatchedAt === undefined); // readLastStage returns only the identity fields
  assert.ok(JSON.parse(fs.readFileSync(lastFile, "utf8")).dispatchedAt);
});

test("readLastStage: missing / malformed → null", () => {
  fs.writeFileSync(lastFile, "not json");
  assert.equal(readLastStage(lastFile), null);
  fs.writeFileSync(lastFile, JSON.stringify({ project: "x" }));
  assert.equal(readLastStage(lastFile), null);
  assert.equal(readLastStage(path.join(tmp, "nope.json")), null);
});

test("stageUnitResult: parses --value stdout; exec failure → null", async () => {
  assert.equal(await stageUnitResult("u", async (bin, args) => ({ stdout: "timeout\n" })), "timeout");
  assert.equal(await stageUnitResult("u", async () => ({ stdout: "  " })), null);
  assert.equal(await stageUnitResult("u", async () => { throw new Error("no unit"); }), null);
});

test("redispatchTimedOutStage: nothing recorded → null", async () => {
  fs.writeFileSync(lastFile, JSON.stringify({ project: "x", stage: "y", unit: "u" }));
  fs.unlinkSync(lastFile);
  const fakeExec = async () => { throw new Error("should not exec"); };
  assert.equal(await redispatchTimedOutStage({ execFn: fakeExec }), null);
});

test("redispatchTimedOutStage: unit Result=timeout → pending file written for re-dispatch", async () => {
  recordLastStage({ project: "offgridusb-2.0", stage: "implement", unit: "dude-eng-offgridusb-2.0-implement" }, lastFile);
  const execFn = async () => ({ stdout: "timeout\n" });
  const res = await redispatchTimedOutStage({ execFn });
  assert.deepEqual(res, {
    requeued: true,
    project: "offgridusb-2.0",
    stage: "implement",
    unit: "dude-eng-offgridusb-2.0-implement",
  });
  assert.deepEqual(readPendingStage(pendingFile), { project: "offgridusb-2.0", stage: "implement" });
  clearPendingStage();
});

test("redispatchTimedOutStage: non-timeout result → null, nothing queued", async () => {
  recordLastStage({ project: "x", stage: "y", unit: "u" }, lastFile);
  for (const result of ["success", "failed", null]) {
    const execFn = async () => ({ stdout: `${result}\n` });
    assert.equal(await redispatchTimedOutStage({ execFn }), null, result);
    assert.equal(fs.existsSync(pendingFile), false);
  }
});

test("redispatchTimedOutStage: won't clobber an already-queued pending stage", async () => {
  fs.writeFileSync(pendingFile, JSON.stringify({ project: "queued", stage: "s" }));
  recordLastStage({ project: "x", stage: "y", unit: "u" }, lastFile);
  const fakeExec = async () => { throw new Error("should not exec"); };
  assert.equal(await redispatchTimedOutStage({ execFn: fakeExec }), null);
  assert.deepEqual(readPendingStage(pendingFile), { project: "queued", stage: "s" });
  clearPendingStage();
});

test("dispatchPendingStage records last-stage for timeout detection", async () => {
  fs.writeFileSync(pendingFile, JSON.stringify({ project: "p", stage: "s" }));
  const spawnFn = () => ({ stderr: { on: () => {} }, on: (ev, cb) => { if (ev === "exit") setImmediate(() => cb(0)); } });
  await dispatchPendingStage({ spawnFn });
  const last = readLastStage(lastFile);
  assert.equal(last.project, "p");
  assert.equal(last.unit, "dude-eng-p-s");
  clearPendingStage();
});
