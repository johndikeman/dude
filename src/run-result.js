/**
 * run-result — how a wait-runner learns what happened to a DETACHED
 * agent run.
 *
 * with detached spawns (systemd-run transient units) the wait runner can't
 * wait for the agent's exit code, so it needs a handoff. the agent writes
 * this file on every process exit:
 *
 *   { ts, exitCode, sessionFile?, purpose?, pid }
 *
 * the runner's lazy re-baseline then decides:
 *   - newer result + exit 0   → refresh the function state (clean)
 *   - newer result + exit != 0 → leave state stale (re-fire next tick)
 *   - no newer result          → agent died before writing (e.g. SIGKILL):
 *     leave state stale after a grace period
 */

import fs from "fs";
import path from "path";

export function defaultLastRunFile() {
  return process.env.DUDE_LAST_RUN_FILE ||
    path.join(
      process.env.DUDE_CONFIG_DIR || path.join(process.env.HOME || "/tmp", ".config/dude"),
      "last-run.json",
    );
}

/**
 * record the current process's exit. call site: index.js registers this
 * on `process.on("exit")` — handlers there are sync-only, which is fine
 * since this is a single small write.
 */
export function writeRunResult({ exitCode, sessionFile = null, purpose = null, file = defaultLastRunFile() } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        ts: new Date().toISOString(),
        exitCode,
        sessionFile,
        purpose,
        pid: process.pid,
      }),
    );
  } catch {
    /* nothing depends on this write succeeding */
  }
}

/** read the last run result; null when missing/corrupt. */
export function readLastRun(file = defaultLastRunFile()) {
  try {
    const r = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof r.exitCode === "number" && typeof r.ts === "string" ? r : null;
  } catch {
    return null;
  }
}

/**
 * is there a run result newer than `firedAt` (an ISO ts or epoch ms)?
 * returns the result, or null.
 */
export function newerThan(result, firedAt) {
  if (!result) return null;
  const t = typeof firedAt === "string" ? Date.parse(firedAt) : firedAt;
  if (Number.isNaN(Date.parse(result.ts)) || !(Date.parse(result.ts) > t)) return null;
  return result;
}
