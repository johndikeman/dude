// discord typing indicator loop.
// discord's "typing..." state expires ~10s after each sendTyping(), so we
// re-send on an interval until stopped.

/** how often to refresh the typing indicator (must be < 10s expiry) */
export const TYPING_REFRESH_INTERVAL_MS = 8000;

/**
 * start repeatedly triggering the channel's typing indicator.
 * @param {{sendTyping: () => Promise<unknown>, id?: string}} channel - a discord.js text channel
 * @param {{intervalMs?: number, log?: (msg: string) => void}} [options]
 * @returns {() => void} stop function; safe to call multiple times
 */
export function startTypingLoop(channel, options = {}) {
  const intervalMs = options.intervalMs ?? TYPING_REFRESH_INTERVAL_MS;
  const log = options.log ?? (() => {});
  if (!channel || typeof channel.sendTyping !== "function") {
    log("typing: invalid channel, skipping indicator");
    return () => {};
  }

  let stopped = false;
  const trigger = async () => {
    try {
      await channel.sendTyping();
    } catch (e) {
      // non-fatal: rate limits / deleted channels shouldn't kill the agent
      log(`typing: sendTyping failed: ${e?.message || e}`);
    }
  };

  trigger();
  const timer = setInterval(trigger, intervalMs);

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}
