/**
 * tool-loop detection + breaker.
 *
 * the primary model (z-ai/glm-5.3-flash via openrouter) occasionally
 * degenerates into repeating the exact same tool call forever. seen
 * 2026-08-31 (session 01a059cf): the model wrote a test file that only
 * printed usage text, then re-ran `node test_gd.js 2>&1` 813 times
 * back-to-back (~1 call/sec, zero text output, identical result every
 * time) until the orchestrator's ~1h timeout killed the run — burning
 * ~416k tokens and doing nothing.
 *
 * pi won't stop on its own: every call returns stopReason "toolUse", so
 * the agent loop just keeps going. cheap models on fast, deterministic
 * tool results are the worst case — nothing in the provider retry /
 * compaction machinery notices.
 *
 * countermeasure: watch tool_execution_start events, and when the same
 * (toolName, args) signature dominates the recent window:
 *   1. first trip → steer() a "break the loop" message into the session.
 *      this changes the model's context at the next LLM call, which is
 *      usually enough to shake it out of the rut.
 *   2. if it keeps looping past the grace allowance → session.abort().
 *      a steer alone isn't guaranteed to work (the model can ignore the
 *      new message), so the abort is the hard backstop that terminates
 *      the run instead of looping for an hour.
 */

/** how many recent tool executions to look at */
export const LOOP_WINDOW = Number(process.env.DUDE_LOOP_WINDOW ?? 16);

/** repeats of one signature within the window that count as a loop */
export const LOOP_THRESHOLD = Number(process.env.DUDE_LOOP_THRESHOLD ?? 8);

/** after the steer, how many extra repeats we tolerate before aborting */
export const LOOP_BREAK_GRACE = Number(process.env.DUDE_LOOP_GRACE ?? 4);

/**
 * rolling-window detector for repeated identical tool calls.
 * stateful — create one per agent session.
 * @param {{window?: number, threshold?: number}} [options]
 */
export function createToolLoopDetector({ window = LOOP_WINDOW, threshold = LOOP_THRESHOLD } = {}) {
  if (!Number.isFinite(window) || window < 1) throw new Error("window must be >= 1");
  if (!Number.isFinite(threshold) || threshold < 1) throw new Error("threshold must be >= 1");
  /** @type {string[]} */
  const recent = [];

  return {
    window,
    threshold,
    /** reset all observed state (used between separate agent runs) */
    reset() {
      recent.length = 0;
    },
    /**
     * record one tool execution start.
     * @param {string} toolName
     * @param {any} args
     * @returns {{isLoop: boolean, repeats: number, signature: string}}
     *   repeats = how many times the *current* signature appears in the window
     */
    observe(toolName, args) {
      let signature;
      try {
        signature = `${toolName}(${JSON.stringify(args) ?? "undefined"})`;
      } catch {
        signature = `${toolName}(<unserializable args>)`;
      }
      recent.push(signature);
      if (recent.length > window) recent.shift();
      const repeats = recent.reduce((n, s) => (s === signature ? n + 1 : n), 0);
      return { isLoop: repeats >= threshold, repeats, signature };
    },
  };
}

/**
 * build the steer message injected when a loop first trips. phrased so a
 * model that's stuck mid-rut gets a concrete instruction to do something
 * different, not a vague nudge.
 * @param {string} signature
 * @param {number} repeats
 * @returns {string}
 */
export function loopBreakPrompt(signature, repeats) {
  return (
    `[system] you have just made the identical tool call \`${signature}\` ` +
    `${repeats} times in a row with the identical result. that is a loop — ` +
    `it will not produce a different outcome no matter how many times you ` +
    `repeat it. stop re-running it. instead: read the actual tool output ` +
    `carefully, form a hypothesis about why the result isn't what you ` +
    `expect, and take a *different* action (inspect state with a different ` +
    `command, edit a file, or ask for help). if you were waiting for ` +
    `something external to change, say so in a message instead of polling.`
  );
}

/**
 * human-readable summary for the discord failure report when the breaker
 * fires.
 * @param {string} signature
 * @param {number} repeats
 * @returns {string}
 */
export function loopAbortSummary(signature, repeats) {
  return (
    `agent run terminated by loop breaker: the model repeated the identical ` +
    `tool call \`${signature}\` ${repeats} times without changing behavior, ` +
    `even after being nudged out of the loop.`
  );
}
