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
 *
 * implementation note (2026-11-10): the tick is a self-rescheduling
 * setTimeout *inside* the callback in the original design, which meant
 * a lost/dropped re-arm silently disarmed the watchdog forever (the
 * 2026-11-09 22:58 session produced ZERO watchdog output during a
 * 100-minute hung llm request, cause never fully identified — see
 * diagnose/ notes). the tick is now a real interval: libuv keeps firing
 * it every diagMs no matter what any single callback does, so the
 * watchdog cannot be silently disarmed by a missed re-arm.
 *
 * observability (2026-11-10): the 2026-11-09 stall's root cause stayed
 * open because the decisive facts — was the timer armed, were events
 * still arriving, was the node event loop blocked — lived only in
 * process memory and died with the crash. the watchdog now takes a
 * `getDiagnostics` callback whose output is appended to every diag/fire
 * line and included in the onStall payload, so one stall incident
 * answers those questions from the persistent log alone.
 */
export function createStallWatchdog({
  stallMs: stallThreshold = stallMs(),
  diagMs: diagInterval = diagMs(),
  log = console.error,
  onStall = () => {},
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  nowFn = () => Date.now(),
  getDiagnostics = null,
} = {}) {
  if (stallThreshold == null || stallThreshold <= 0) {
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
    if (timer) return; // interval already ticking — nothing to do
    timer = setIntervalFn(check, diagInterval);
    if (typeof timer.unref === "function") timer.unref();
  };

  const unschedule = () => {
    if (timer) {
      clearIntervalFn(timer);
      timer = null;
    }
  };

  function check() {
    if (stopped) return;
    const now = nowFn();
    const idle = now - lastActivityAt;
    let extras = "";
    try {
      extras = getDiagnostics ? ` ${getDiagnostics()}` : "";
    } catch (e) {
      extras = ` diagnostics-failed: ${e?.message || e}`;
    }
    // an in-flight tool is legitimate silence — don't diag or fire,
    // just look again after another interval
    if (toolDepth > 0) {
      return;
    }
    if (idle >= stallThreshold) {
      stallCount += 1;
      let diag = {
        idleMs: idle,
        lastEventType,
        stallCount,
        idleSince: new Date(lastActivityAt).toISOString(),
      };
      if (getDiagnostics) {
        try {
          diag.eventLoopLagAndEventCounts = getDiagnostics();
        } catch {
          /* extras already best-effort */
        }
      }
      // abort FIRST, log after: a slow/blocking log call must never
      // prevent the recovery abort from happening (the 2026-11-09
      // session showed timer-callback log paths can wedge).
      try {
        onStall(diag);
      } catch (e) {
        log(`llm stall watchdog: onStall handler threw: ${e?.stack || e?.message || e}`);
      }
      log(
        `llm stall watchdog: fired after ${fmtMs(idle)} with no agent activity ` +
          `(last event: ${lastEventType} at ${new Date(lastActivityAt).toISOString()}; ` +
          `toolDepth=${toolDepth}; stalls this run=${stallCount})${extras}; aborting session so the hung request is killed and the run can be nudged`,
      );
      // stop watching until the recovery path feeds/resets us
      unschedule();
      return;
    }
    if (idle >= diagInterval && now - lastDiagAt >= diagInterval) {
      lastDiagAt = now;
      log(
        `llm stall watchdog: no agent activity for ${fmtMs(idle)} ` +
          `(last event: ${lastEventType}; toolDepth=${toolDepth}; abort at ${fmtMs(stallThreshold - idle)})${extras}`,
      );
    }
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
      unschedule();
    },
    state: () => ({
      toolDepth,
      lastEventType,
      idleMs: nowFn() - lastActivityAt,
      stallCount,
    }),
  };
}

/** event types that do NOT count as real progress for the stall watchdog.
 *
 * auto_retry_start/end: pi's provider-level retry emits these between
 * attempts during exponential backoff. counting them as activity made the
 * watchdog blind to a flapping llm connection that retried (and never
 * streamed real output) for 25+ minutes — incident 2026-11-06, session
 * 01a1b2d2. during a retry there's no new model output, so backoff waits
 * count as idle and the watchdog can abort a wedged retry loop.
 */
export const NON_PROGRESS_EVENTS = new Set(["auto_retry_start", "auto_retry_end"]);

/** true when this event type should feed the stall watchdog's idle clock */
export function isStallProgressEvent(eventType) {
  return !NON_PROGRESS_EVENTS.has(eventType);
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
