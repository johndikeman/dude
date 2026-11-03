/**
 * process-level crash guard for transient websocket/network errors.
 *
 * problem (seen live 2026-11-03, twice): discord.js's gateway/websocket
 * layer can emit an unhandled 'error' event on a raw ws WebSocket
 * instance — "Opening handshake has timed out" during a network blip —
 * and node treats an unhandled 'error' event on an EventEmitter as
 * fatal: the process dies mid-run with no cleanup (session lost, systemd
 * restarts from scratch).
 *
 * fix: intercept uncaughtException/unhandledRejection and, for known-
 * transient network errors originating inside the ws / @discordjs stack,
 * log and CONTINUE (discord.js re-connects on its own; notify clients are
 * throwaway). anything else is a real bug: log the full stack and exit 1
 * so systemd still sees a failure and restarts us.
 *
 * note: swallowing an exception thrown in the middle of application logic
 * is generally bad — but these errors are thrown asynchronously from the
 * socket layer with no connection to in-flight control flow, so there's
 * no intermediate state to corrupt.
 */

let installed = false;

export const TRANSIENT_RE =
  /opening handshake has timed out|websocket|econnreset|econnrefused|econnaborted|etimedout|ehostunreach|enetunreach|socket hang up|epipe|connection was closed|network error|read econnreset/i;

export const WS_STACK_RE = /node_modules[\\/](ws|@discordjs)[\\/]/;

/** true when this error is a transient network error from the ws layer */
export function isTransientWsError(err) {
  if (!err || err instanceof Error === false) return false;
  const stack = err.stack || "";
  const message = err.message || "";
  // must both look transient AND come from the websocket layer — never
  // swallow errors thrown from our own/dude's code
  return TRANSIENT_RE.test(message) && WS_STACK_RE.test(stack);
}

/** install the guard (idempotent). returns the handlers for testability. */
export function installCrashGuard({ log = console.error } = {}) {
  if (installed) return { ok: true, alreadyInstalled: true };
  installed = true;

  process.on("uncaughtException", (err) => {
    if (isTransientWsError(err)) {
      log(
        `crash-guard: swallowed transient websocket error (continuing): ${err.message}`,
      );
      return;
    }
    log(`crash-guard: fatal uncaught exception: ${err?.stack || err}`);
    // real bug — exit non-zero so systemd marks the run failed and
    // restarts. flush is implicit for console.error (stderr).
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : null;
    if (err && isTransientWsError(err)) {
      log(
        `crash-guard: swallowed transient websocket rejection (continuing): ${err.message}`,
      );
      return;
    }
    log(
      `crash-guard: fatal unhandled rejection: ${
        err?.stack || String(reason)
      }`,
    );
    // node's default behavior (>=15) already crashes the process on
    // unhandled rejections; keep that semantics but log a readable stack.
    process.exit(1);
  });

  return { ok: true, alreadyInstalled: false };
}
