/**
 * tests for src/dude2/registry.js + presence.js — agents-state.json
 * bookkeeping, concurrency cap, presence text.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  readState, writeState, registerRun, markExited, listRunning, canSpawn, pruneFinished,
} from "./../src/dude2/registry.js";
import { presenceText, IDLE_LINES } from "./../src/dude2/presence.js";

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dude2-reg-"));
  return path.join(dir, "agents-state.json");
}

test("readState on missing/corrupt file returns empty registry", () => {
  assert.deepEqual(readState("/nonexistent/state.json"), { updatedAt: null, runs: [] });
  const f = tmpFile();
  fs.writeFileSync(f, "{corrupt");
  assert.deepEqual(readState(f), { updatedAt: null, runs: [] });
});

test("registerRun + markExited lifecycle and state shape", () => {
  const f = tmpFile();
  registerRun(f, { runId: "run-1", pid: 123, purpose: "eng-orchestrator", model: "glm-5.3" });
  let state = readState(f);
  assert.equal(state.runs.length, 1);
  assert.equal(state.runs[0].status, "running");
  assert.equal(state.runs[0].purpose, "eng-orchestrator");
  assert.equal(listRunning(f).length, 1);
  markExited(f, "run-1", 0);
  state = readState(f);
  assert.equal(state.runs[0].status, "done");
  assert.equal(listRunning(f).length, 0);
});

test("canSpawn enforces the concurrency cap", () => {
  const f = tmpFile();
  registerRun(f, { runId: "a" });
  registerRun(f, { runId: "b" });
  assert.equal(canSpawn(f, 3), true);
  registerRun(f, { runId: "c" });
  assert.equal(canSpawn(f, 3), false);
  assert.equal(canSpawn(f, 4), true);
  markExited(f, "a", 0);
  assert.equal(canSpawn(f, 3), true);
});

test("pruneFinished drops old finished runs, keeps running ones", () => {
  const f = tmpFile();
  registerRun(f, { runId: "live" });
  registerRun(f, { runId: "old" });
  markExited(f, "old", 0);
  // backdate the finished run beyond the prune window
  const state = readState(f);
  state.runs.find((r) => r.runId === "old").endedAt = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  writeState(f, state);
  const pruned = pruneFinished(f, 24 * 3600 * 1000);
  assert.deepEqual(pruned.runs.map((r) => r.runId), ["live"]);
});

test("presenceText: idle vs running summaries", () => {
  assert.ok(IDLE_LINES.includes(presenceText({ runs: [] })));
  const one = presenceText({ runs: [{ status: "running", purpose: "eng-orchestrator" }] });
  assert.match(one, /herding 1 agent \(eng-orchestrator\)/);
  const many = presenceText({
    runs: [
      { status: "running", purpose: "a" },
      { status: "running", purpose: "b" },
      { status: "running", purpose: "c" },
    ],
  });
  assert.match(many, /herding 3 agents \(a, b, \.\.\.\)/);
  // finished runs don't count
  const doneOnly = presenceText({ runs: [{ status: "done", purpose: "a" }] });
  assert.ok(IDLE_LINES.includes(doneOnly));
});
