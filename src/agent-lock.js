/**
 * cross-process agent lock.
 *
 * prevents multiple dude-agent instances from running at the same time
 * (scheduled timer run + wait-fired run + discord-triggered run stepping
 * on one another's sessions/task-file edits).
 *
 * a lock file at $DUDE_CONFIG_DIR/agent-lock.json holds
 *   { pid, startedAt, purpose? }
 *
 * rules:
 *   - no file / corrupt file        -> acquire
 *   - file present, holder pid dead -> stale (crash/OOM): take over
 *   - file present, pid alive       -> busy
 *
 * exit code 75 (EX_TEMPFAIL) is used when an invocation is skipped due to
 * the lock — callers (wait runner, timers) treat non-zero as "retry/leave
 * state alone" rather than "failed".
 */

import fs from "fs";
import path from "path";

/** exit code for "skipped because another agent holds the lock" */
export const LOCK_SKIPPED_EXIT_CODE = 75;

export function defaultLockFile() {
  return process.env.DUDE_AGENT_LOCK_FILE ||
    path.join(
      process.env.DUDE_CONFIG_DIR || path.join(process.env.HOME || "/tmp", ".config/dude"),
      "agent-lock.json",
    );
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but belongs to another user — still alive
    return err && err.code === "EPERM";
  }
}

/** read and parse the lock file; returns null if missing/corrupt/stale-dead */
export function readLock(file = defaultLockFile()) {
  try {
    const lock = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof lock.pid !== "number" || !isPidAlive(lock.pid)) return null;
    return lock;
  } catch {
    return null;
  }
}

/** true if some live agent process holds the lock right now */
export function isAgentRunning(file = defaultLockFile()) {
  return readLock(file) !== null;
}

/**
 * try to acquire the lock. returns the lock object on success, or null if
 * another live agent holds it. a dead holder's lock is taken over.
 */
export function acquireLock({ purpose = null, file = defaultLockFile(), now = new Date().toISOString() } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = readLock(file);
  if (existing) return null; // alive holder -> busy
  const lock = { pid: process.pid, startedAt: now, purpose };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lock, null, 2));
  // atomic-ish publish; unlink the tmp only if rename failed
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing */ }
    throw err;
  }
  return lock;
}

/** release the lock, but only if we still hold it. non-fatal on failure. */
export function releaseLock(file = defaultLockFile()) {
  try {
    const lock = JSON.parse(fs.readFileSync(file, "utf8"));
    if (lock.pid === process.pid) fs.unlinkSync(file);
  } catch {
    /* already gone or unreadable: nothing to do */
  }
}

/**
 * convenience for --once style invocations: acquire, and if busy log +
 * exit 75 so upstream runners know to retry later rather than treat it
 * as a failure. registers an exit hook so the lock is always released
 * when the process dies.
 */
export function acquireLockOrExit({ purpose = null, log = console.error, file = defaultLockFile() } = {}) {
  const lock = acquireLock({ purpose, file });
  if (lock) {
    process.on("exit", () => releaseLock(file));
    return lock;
  }
  const holder = readLock(file);
  log(
    `agent lock held (pid ${holder?.pid ?? "?"}, started ${holder?.startedAt ?? "?"}); skipping this run (${LOCK_SKIPPED_EXIT_CODE})`,
  );
  process.exit(LOCK_SKIPPED_EXIT_CODE);
}
