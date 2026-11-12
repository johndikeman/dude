/**
 * dude2 agent registry — who is running right now.
 *
 * the dispatcher publishes ~/.config/dude2/agents-state.json (path from
 * config, nix-overridable) describing every run it spawned:
 *
 *   { updatedAt, runs: [{ runId, pid, purpose, model, startedAt, status }] }
 *
 * this file feeds the discord presence summarizer and the orchestrator.
 * pure + fs-injectable so e2e/unit tests run it against a temp dir.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

/** default cap: 3 concurrent runs (design: tune empirically on the vps) */
export const DEFAULT_MAX_CONCURRENT = 3;

export function newRunId(prefix = "run") {
  return `${prefix}-${crypto.randomBytes(4).toString("hex")}`;
}

/** read the state file; empty registry shape when missing/corrupt. */
export function readState(file, fsMod = fs) {
  try {
    const s = JSON.parse(fsMod.readFileSync(file, "utf8"));
    return { updatedAt: s.updatedAt ?? null, runs: Array.isArray(s.runs) ? s.runs : [] };
  } catch {
    return { updatedAt: null, runs: [] };
  }
}

/** write the state file atomically (tmp + rename). */
export function writeState(file, state, fsMod = fs) {
  fsMod.mkdirSync(path.dirname(file), { recursive: true });
  const payload = JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2);
  const tmp = `${file}.${process.pid}.tmp`;
  fsMod.writeFileSync(tmp, payload);
  fsMod.renameSync(tmp, file);
}

/** register a new run. returns the updated state. */
export function registerRun(file, { runId, pid = null, purpose = null, model = null }, fsMod = fs) {
  const state = readState(file, fsMod);
  state.runs = state.runs.filter((r) => r.runId !== runId);
  state.runs.push({
    runId,
    pid,
    purpose,
    model,
    startedAt: new Date().toISOString(),
    status: "running",
  });
  writeState(file, state, fsMod);
  return state;
}

/** mark a run exited (kept in the file for a while; status = exit code). */
export function markExited(file, runId, exitCode, fsMod = fs) {
  const state = readState(file, fsMod);
  const run = state.runs.find((r) => r.runId === runId);
  if (run) {
    run.status = exitCode === 0 ? "done" : "failed";
    run.exitCode = exitCode;
    run.endedAt = new Date().toISOString();
  }
  writeState(file, state, fsMod);
  return state;
}

/** prune finished runs older than maxAgeMs so the file doesn't grow forever. */
export function pruneFinished(file, maxAgeMs = 24 * 60 * 60 * 1000, fsMod = fs) {
  const state = readState(file, fsMod);
  const cutoff = Date.now() - maxAgeMs;
  state.runs = state.runs.filter((r) => {
    if (r.status === "running") return true;
    const ended = r.endedAt ? Date.parse(r.endedAt) : 0;
    return ended > cutoff;
  });
  writeState(file, state, fsMod);
  return state;
}

/** currently-running runs. */
export function listRunning(file, fsMod = fs) {
  return readState(file, fsMod).runs.filter((r) => r.status === "running");
}

/**
 * can the dispatcher spawn another run right now? respects the
 * concurrency cap (design default 3, env-overridable).
 */
export function canSpawn(file, maxConcurrent = DEFAULT_MAX_CONCURRENT, fsMod = fs) {
  return listRunning(file, fsMod).length < maxConcurrent;
}
