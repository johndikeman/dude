/**
 * empty-response retry logic.
 *
 * the primary model (z-ai/glm-5.3-flash via openrouter) intermittently
 * returns a completely empty response (stopReason "stop", zero output
 * tokens). pi treats that as a successful settle and the session just
 * ends — sometimes mid-task, right after a tool result, leaving work
 * half-finished (seen repeatedly in sessions from 2026-08-28/29).
 *
 * instead of ending the run, we detect the empty settle and re-prompt
 * the same (still-open) session with a short "continue" nudge. the model
 * sees its full context including any pending tool results and picks up
 * where it stopped.
 */

export const MAX_EMPTY_RESPONSE_RETRIES = Number(
  process.env.DUDE_MAX_EMPTY_RETRIES ?? 2,
);

/**
 * decide whether an agent_settled event should be treated as an
 * empty-response failure worth nudging.
 * @param {{lastAssistantText?: string | undefined, error?: string | undefined, attemptsSoFar: number}} p
 * @returns {boolean}
 */
export function shouldNudge({ lastAssistantText, error, attemptsSoFar }) {
  if (attemptsSoFar >= MAX_EMPTY_RESPONSE_RETRIES) return false;
  // a real error means pi's retry/compaction machinery already handled
  // (or surfaced) the failure — nudging on top would just compound it
  if (error) return false;
  return !lastAssistantText || lastAssistantText.trim().length === 0;
}

/**
 * build the nudge prompt sent back to the session after an empty response.
 * @param {number} attempt - 1-based nudge attempt number
 * @returns {string}
 */
export function nudgePrompt(attempt) {
  return (
    `your previous response came back completely empty (provider glitch, ` +
    `not an intentional stop). this is nudge ${attempt} — continue exactly ` +
    `where you left off: check your recent tool results and the task file, ` +
    `and keep working. if you genuinely have nothing left to do, reply with ` +
    `a short summary of the current state instead of an empty response.`
  );
}
