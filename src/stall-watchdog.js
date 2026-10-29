/**
 * llm-stall watchdog.
 *
 * incident 2026-10-29 (session 01a1888d): the last tool result landed at
 * 16:51:50Z, then the next llm request to openrouter (glm-5.3-flash)
 * hung with zero events — no streaming chunks, no settle, no error —
 * for 41 minutes until a SIGTERM killed the run. pi has no per-request
 * inactivity timeout and the harness only had the 4h wall-clock cap
 * between "activity" and "hard kill", so a silently-stalled backend
 * looked like the run simply vanished.
 *
 * this module watches agent activity (message_start/update/end, tool
 * execution events) and, when the session has been idle for
 * `stallMs` with no tool running:
 *   1. logs a verbose diagnostic (idle time, last event seen, whether
 *      any output ever streamed this turn) — future debugging data
 *   2. aborts the session, which kills the hung http request and
 *      triggers the agent_settled path, where index.js re-prompts the
 *      session to continue (capped by DUDE_MAX_STALL_RETRIES)
 *
 * a long-running tool does NOT count as a stall: tool_execution_start
 * increments a depth counter and the watchdog defers while it's > 0.
 *
 * env: DUDE_LLM_STALL_MS (abort threshold, default 10m; 0 disables),
 *      DUDE_STALL_DIAG_MS (verbose diag interval, default 2m),
 *      DUDE_MAX_STALL_RETRIES (nudges per run, default 2).
 */

/** abort a session that has produced no agent activity for this long */
export const DEFAULT_STALL_MS = 10 * 60 * 1000;
/** how often (of silence) to log a verbose diagnostic while stalling */
export const DEFAULT_DIAG_MS = 2 * 60 * 1000;

export function maxStallRetries(env = process.env) {
  const raw = env.DUDE_MAX_STALL_RETRIES;
  if (raw == null || raw === "") return 2;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 2;
  return Math.floor(parsed);
}

export function stallMs(env = process.env) {
  const raw = env.DUDE_LLM_STALL_MS;
  if (raw == null || raw === "") return DEFAULT_STALL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_STALL_MS;
  return Math.max(0, parsed);
}

export function diagMs(env = process.env) {
  const raw = env.DUDE_STALL_DIAG_MS;
  if (raw == null || raw === "") return DEFAULT_DIAG_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_DIAG_MS;
  return Math.max(1000, parsed);
}

function fmtMs(ms) {
  if (ms >= 60000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 1000)}s`;
}

/**
 * create a stall watchdog for one agent run.
 * feed() every agent event; onStall({idleMs, lastEventType, ...}) fires
 * at most once per run unless reset() is called (index.js resets it on
 * a successful re-prompt after a stall-abort).
 */
export function createStallWatchdog({
  stallMs: stallThreshold = stallMs(),
  diagMs: diagInterval = diagMs(),
  log = console.error,
  onStall = () => {},
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  nowFn = () => Date.now(),
} = {}) {
  if (!stallThreshold || stallThreshold <= 0) {
    return {
      feed() {},
      reset() {},
      stop() {},
      state: () => ({ disabled: true }),
    };
  }

  let stopped = false;
  let toolDepth = 0; // tool_execution_start/end nesting
  let lastActivityAt = nowFn();
  let lastEventType = "watchdog-started";
  let lastDiagAt = 0;
  let stallCount = 0;
  let timer = null;

  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimeoutFn(timer);
    // check at the diag interval; each check either logs a diag line,
    // fires the stall handler once, or re-arms itself.
    timer = setTimeoutFn(check, diagInterval);
    if (typeof timer.unref === "function") timer.unref();
  };

  function check() {
    if (stopped) return;
    const now = nowFn();
    const idle = now - lastActivityAt;
    // an in-flight tool is legitimate silence — don't diag or fire,
    // just look again after another interval
    if (toolDepth > 0) {
      schedule();
      return;
    }
    if (idle >= stallThreshold) {
      stallCount += 1;
      log(
        `llm stall watchdog: firing after ${fmtMs(idle)} with no agent activity ` +
          `(last event: ${lastEventType} at ${new Date(lastActivityAt).toISOString()}; ` +
          `toolDepth=${toolDepth}; stalls this run=${stallCount}); aborting session so the hung request is killed and the run can be nudged`,
      );
      try {
        onStall({
          idleMs: idle,
          lastEventType,
          stallCount,
          idleSince: new Date(lastActivityAt).toISOString(),
        });
      } catch (e) {
        log(`llm stall watchdog: onStall handler threw: ${e?.stack || e?.message || e}`);
      }
      return; // not re-armed: index.js feeds/reset resumes watching
    }
    if (idle >= diagInterval && now - lastDiagAt >= diagInterval) {
      lastDiagAt = now;
      log(
        `llm stall watchdog: no agent activity for ${fmtMs(idle)} ` +
          `(last event: ${lastEventType}; toolDepth=${toolDepth}; abort at ${fmtMs(stallThreshold - idle)})`,
      );
    }
    schedule();
  }

  return {
    /** record agent activity; tool events also toggle the tool-depth pause */
    feed(eventType) {
      if (stopped) return;
      if (eventType === "tool_execution_start") toolDepth += 1;
      else if (eventType === "tool_execution_end") toolDepth = Math.max(0, toolDepth - 1);
      lastActivityAt = nowFn();
      lastEventType = eventType;
      lastDiagAt = lastActivityAt; // diag counts from the latest activity
      schedule();
    },
    /** re-arm after a stall-abort + successful re-prompt */
    reset() {
      if (stopped) return;
      toolDepth = 0;
      lastActivityAt = nowFn();
      lastEventType = "watchdog-reset";
      lastDiagAt = 0;
      schedule();
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeoutFn(timer);
        timer = null;
      }
    },
    state: () => ({
      toolDepth,
      lastEventType,
      idleMs: nowFn() - lastActivityAt,
      stallCount,
    }),
  };
}

/** nudge prompt sent after a stall-abort, telling the model to continue */
export function stallNudgePrompt(attempt, { idleMs, idleSince } = {}) {
  return (
    `your previous llm request stalled — the backend sent no data for ` +
    `${fmtMs(idleMs ?? 0)} (since ${idleSince ?? "unknown"}) and the harness ` +
    `aborted the hung request to recover. this is stall-recovery nudge ${attempt}. ` +
    `continue exactly where you left off: check your recent tool results and the ` +
    `task file, and keep working. if you genuinely have nothing left to do, reply ` +
    `with a short summary of the current state instead of going silent.`
  );
}
