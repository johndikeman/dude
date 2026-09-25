/**
 * runtime cap for agent runs.
 *
 * incident 2026-09-24: a wait-fired ai-tasks run (monitor search) got
 * stuck in a ~11-minute cloudflare-turnstile cooloff loop and ran for
 * 13h 3min wall clock. the whole time it held the cross-process agent
 * lock, so every other scheduled dude cycle (prediction-markets agent,
 * wait ticks, discord-triggered runs) was skipped with exit 75 — one
 * runaway run effectively killed all of dude. the failure was blamed on
 * an unrelated prediction-markets flake bump, which was manually reverted.
 *
 * this module gives every run a hard wall-clock cap:
 *   - soft cap: log + abort the pi session (the settled handler ends the
 *     run cleanly)
 *   - grace period later: hard kill (releaseLock + exit 124) in case the
 *     abort didn't settle the session
 *
 * env: DUDE_MAX_RUNTIME_MS (ms, "0" disables the cap).
 */

import process from "process";

/** default cap: 4h — pm agent cycles run ~20-45min; the longest sane
 * full-task run (browser-heavy searches) should still fit well under. */
export const DEFAULT_MAX_RUNTIME_MS = 4 * 60 * 60 * 1000;

/** grace between "abort session" and the hard kill */
export const DEFAULT_HARD_KILL_GRACE_MS = 60 * 1000;

/** exit code for "killed because the run exceeded its wall-clock cap" */
export const RUNTIME_CAP_EXIT_CODE = 124;

/** parse the configured cap; 0 or a negative number disables the cap */
export function maxRuntimeMs(env = process.env) {
  const raw = env.DUDE_MAX_RUNTIME_MS;
  if (raw == null || raw === "") return DEFAULT_MAX_RUNTIME_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_RUNTIME_MS;
  return Math.max(0, parsed);
}

function fmtDuration(ms) {
  const mins = Math.round(ms / 60000);
  return mins >= 60 ? `${(mins / 60).toFixed(1)}h` : `${mins}m`;
}

/**
 * start a wall-clock cap for one agent run.
 *
 * at the cap: logs, aborts the session (graceful path), and arms a hard
 * kill that releases the lock and exits 124 if the abort doesn't settle.
 * returns a stop() fn that cancels everything (call when the run ends).
 */
export function startRuntimeCap({
  ms = maxRuntimeMs(),
  log = console.error,
  session = null,
  hardKillGraceMs = DEFAULT_HARD_KILL_GRACE_MS,
  releaseFn = () => {},
  exitFn = (code) => process.exit(code),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (!ms || ms <= 0) return () => false; // cap disabled: never fired
  let stopped = false;
  let abortIssued = false;

  const capTimer = setTimeoutFn(() => {
    if (stopped) return;
    abortIssued = true;
    log(
      `runtime cap exceeded (${fmtDuration(ms)}); aborting session (hard kill in ${Math.round(hardKillGraceMs / 1000)}s if it doesn't settle)`,
    );
    try {
      session?.abort?.()?.catch?.(() => {});
    } catch {
      /* session already gone */
    }
    // if the abort doesn't settle the session, hard kill: release the
    // lock so other runs aren't starved by a zombie, exit 124 so callers
    // can tell a capped run apart from a clean one.
    setTimeoutFn(() => {
      if (stopped) return;
      log(`runtime cap hard kill after ${Math.round(hardKillGraceMs / 1000)}s grace`);
      try { releaseFn(); } catch { /* nothing */ }
      exitFn(RUNTIME_CAP_EXIT_CODE);
    }, hardKillGraceMs);
  }, ms);
  if (typeof capTimer.unref === "function") capTimer.unref();

  return () => {
    stopped = true;
    clearTimeoutFn(capTimer);
    return abortIssued;
  };
}