// discord presence + typing indicator for scheduled (non-discord) runs.
// john: "timer waits (scheduled runs) not triggering the discord presence
// and typing indicator". the main service client handles discord-triggered
// runs (see status.js), but one-shot scheduled runs (--once / cron / wait-
// fired) never call client.login() — the main client is dead, so the
// queued presence in status.js never applied (clientReady never fired) and
// the typing loop had no channel to run in.
//
// fix: one-shot runs lazily create a minimal persistent client, set the
// "Playing running a task" presence, and keep a typing indicator loop in
// the notify channel for the whole run. the run's discord pings (notify.js)
// reuse this client instead of spinning up throwaway ones. cleanup on
// releaseLockAndStopCap() clears the presence and destroys the client.
//
// every step is best-effort: a discord hiccup must never delay or crash a run.

import { Client, GatewayIntentBits } from "discord.js";
import { AGENT_ACTIVITY } from "./status.js";
import { resolveNotifyChannelId } from "./notify.js";
import { startTypingLoop } from "./typing.js";

const LOGIN_TIMEOUT_MS = 15_000;

// module state: null when no scheduled run is holding a presence client
let active = null;
// in-flight acquire — releaseScheduledPresence waits for it so a run that
// ends before the async login finishes still tears the client down
let pending = null;

/**
 * lazily log in a minimal discord client and show the agent-busy presence
 * + typing indicator in the notify channel. no-op when a run is already
 * holding one (returns the same client). resolves null when discord is
 * unavailable (no token / no channel / login timeout / gateway error).
 * @param {{log?: (info: string) => void}} [options]
 * @returns {Promise<{client: import('discord.js').Client} | null>}
 */
export async function acquireScheduledPresence({ log = () => {}, clientFactory } = {}) {
  if (active) return active;
  if (pending) return pending;
  pending = acquireScheduledPresenceInner({ log, clientFactory }).finally(() => {
    pending = null;
  });
  return pending;
}

async function acquireScheduledPresenceInner({ log = () => {}, clientFactory, loginTimeoutMs = LOGIN_TIMEOUT_MS } = {}) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    log("scheduled-presence: no DISCORD_TOKEN; skipping");
    return null;
  }
  const channelId = resolveNotifyChannelId();
  if (!channelId) {
    log("scheduled-presence: no notify channel id; skipping");
    return null;
  }
  // clientFactory is a test seam: lets tests inject a fake discord client
  const client = clientFactory ? clientFactory() : new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    await loginWithTimeout(client, token, log, loginTimeoutMs);
    await client.user.setActivity(AGENT_ACTIVITY, { type: 0 /* Playing */ });
    log(`scheduled-presence: presence set to "Playing ${AGENT_ACTIVITY}"`);
    let stopTyping = () => {};
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel && typeof channel.sendTyping === "function") {
        stopTyping = startTypingLoop(channel, { log });
      } else {
        log("scheduled-presence: notify channel not sendable; no typing indicator");
      }
    } catch (e) {
      log(`scheduled-presence: typing indicator failed: ${e?.message || e}`);
    }
    active = { client, stopTyping };
    log("scheduled-presence: acquired");
    return active;
  } catch (e) {
    log(`scheduled-presence: failed to acquire: ${e?.message || e}`);
    try {
      await client.destroy();
    } catch {
      /* nothing */
    }
    return null;
  }
}

/**
 * the persistent client backing the current scheduled run, or null.
 * lets notify.js reuse the same gateway connection for its pings
 * instead of creating throwaway clients per ping.
 * @returns {import('discord.js').Client | null}
 */
export function getScheduledPresenceClient() {
  return active?.client ?? null;
}

/**
 * release the scheduled-run presence: clear the presence, stop the typing
 * loop, destroy the client. safe to call when nothing is active.
 * @param {{log?: (info: string) => void}} [options]
 * @returns {Promise<void>}
 */
export async function releaseScheduledPresence({ log = () => {} } = {}) {
  if (pending) {
    try {
      await pending;
    } catch {
      /* nothing */
    }
  }
  if (!active) return;
  const { client, stopTyping } = active;
  active = null;
  try {
    stopTyping();
  } catch {
    /* nothing */
  }
  try {
    await client.user?.setActivity(null);
    log("scheduled-presence: presence cleared");
  } catch (e) {
    log(`scheduled-presence: failed to clear presence: ${e?.message || e}`);
  }
  try {
    await client.destroy();
    log("scheduled-presence: released");
  } catch (e) {
    log(`scheduled-presence: failed to destroy client: ${e?.message || e}`);
  }
}

/** login with a hard timeout so a hung gateway can never delay the run */
async function loginWithTimeout(client, token, log, timeoutMs = LOGIN_TIMEOUT_MS) {
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("scheduled-presence: discord login timed out")),
      timeoutMs,
    );
    client.once("clientReady", () => {
      clearTimeout(t);
      resolve();
    });
    client.once("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
  // if client.login() throws before we reach `await ready`, the timeout
  // timer can still fire later and reject `ready` — without a handler that
  // becomes an unhandledRejection and kills the one-shot process.
  ready.catch(() => {});
  await client.login(token);
  await ready;
}
