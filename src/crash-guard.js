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
  /opening handshake has timed out|websocket|econnreset|econnrefused|econnaborted|etimedout|ehostunreach|enetunreach|socket hang up|epipe|connection was closed|network error|read econnreset|socket disconnected before secure tls|tls connection.*was established|ssl routines/i;

export const WS_STACK_RE = /node_modules[\\/](ws|@discordjs)[\\/]/;

// incident 2026-11-06 (session 01a1b2d2): a hung openrouter llm request
// eventually surfaced as an uncaughtException from node's tls internals
// ("Client network socket disconnected before secure TLS connection was
// established", stack only node:internal/tls) — a transient network
// blip (obsidian-sync restart churn) that killed the run mid-task with
// exit 1. undici/fetch connect errors can surface the same way. these
// stack frames come from node internals, not our code, so swallowing is
// as safe as for the ws layer.
export const NODE_NET_STACK_RE = /node:internal[\\/](tls|net)|undici|node:internal[\\/]process\/task_queues/i;

/** max transient errors swallowed per 60s window; beyond that it's an
 * error storm — likely a real bug wearing a transient costume. */
export const TRANSIENT_SWALLOW_CAP = 10;
const SWALLOW_WINDOW_MS = 60_000;

/** true when this error is a transient network error from the ws layer
 * (or node's tls/undici internals) */
export function isTransientWsError(err) {
  if (!err || err instanceof Error === false) return false;
  const stack = err.stack || "";
  const message = err.message || "";
  // must both look transient AND come from a socket layer — never
  // swallow errors thrown from our own/dude's code
  return (
    TRANSIENT_RE.test(message) &&
    (WS_STACK_RE.test(stack) || NODE_NET_STACK_RE.test(stack))
  );
}

/** ring of recent swallow timestamps + rate check */
const swallowTimes = [];
export function swallowRateExceeded(now = Date.now()) {
  while (swallowTimes.length && now - swallowTimes[0] > SWALLOW_WINDOW_MS) swallowTimes.shift();
  if (swallowTimes.length >= TRANSIENT_SWALLOW_CAP) return true;
  swallowTimes.push(now);
  return false;
}

/** install the guard (idempotent). returns the handlers for testability. */
export function installCrashGuard({ log = console.error } = {}) {
  if (installed) return { ok: true, alreadyInstalled: true };
  installed = true;

  process.on("uncaughtException", (err) => {
    if (isTransientWsError(err)) {
      if (swallowRateExceeded()) {
        log(
          `crash-guard: ${TRANSIENT_SWALLOW_CAP}+ transient errors in ${SWALLOW_WINDOW_MS / 1000}s — treating as fatal: ${err?.stack || err}`,
        );
        process.exit(1);
      }
      log(
        `crash-guard: swallowed transient network error (continuing): ${err.message}`,
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
      if (swallowRateExceeded()) {
        log(
          `crash-guard: ${TRANSIENT_SWALLOW_CAP}+ transient errors in ${SWALLOW_WINDOW_MS / 1000}s — treating as fatal: ${err?.stack || err}`,
        );
        process.exit(1);
      }
      log(
        `crash-guard: swallowed transient network rejection (continuing): ${err.message}`,
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
