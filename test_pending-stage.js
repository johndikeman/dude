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
