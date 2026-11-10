/**
 * provider auto-retry event handling.
 *
 * pi emits two flavors of `auto_retry_end`:
 *   - { success: true, attempt: N }  — a retry recovered; the retried
 *     response streams normally and the agent loop continues on its own
 *     (pi resets its retry counter on the first good assistant message).
 *   - { success: false, attempt: N, finalError: string } — retries
 *     exhausted; the run is dead.
 *
 * incident 2026-11-09 (session 01a1c288): the success flavor was treated
 * as a terminal failure — the handler logged "pi failed: undefined",
 * tore down the run, and crashed on truncateLine(undefined) inside the
 * discord reply, which the crash-guard turned into process exit 1. the
 * successful retry response's tool call never executed and the user
 * never got a reply.
 */

/**
 * decide whether an auto_retry_end event actually means the run failed.
 * @param {{type: string, success?: boolean, attempt?: number, finalError?: string}} event
 * @returns {boolean}
 */
export function isAutoRetryFailure(event) {
  return event?.type === "auto_retry_end" && event.success === false;
}

/** safe error text for display paths that used to crash on undefined */
export function retryErrorText(finalError) {
  return typeof finalError === "string" && finalError.length > 0
    ? finalError
    : "unknown provider error";
}
