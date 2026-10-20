// discord presence status while the agent is working.
// john: "whenever dude is doing some work we should set a discord status
// (like the in-game type, or whatever just so i can tell a session is
// running)". we show a "Playing <activity>" presence while a run holds
// the agent lock, and clear it when the run ends. every update is
// best-effort: a discord hiccup must never crash or delay a run.

/**
 * @import {Client} from 'discord.js'
 */

/** the presence text shown while a run is active */
export const AGENT_ACTIVITY = "running a task";

/**
 * set the bot presence to show the agent is busy. no-op (logged) when
 * the discord client isn't logged in yet (scheduled runs start before
 * the gateway connection is up).
 * @param {Client | null | undefined} client - discord.js client
 * @param {(info: string) => void} [log] - logger
 * @returns {void}
 */
export function setAgentStatus(client, log = () => {}) {
  try {
    if (!client?.user) {
      log("status: discord client not ready, skipping presence update");
      return;
    }
    client.user.setActivity(AGENT_ACTIVITY, { type: 0 /* Playing */ });
    log(`status: presence set to "Playing ${AGENT_ACTIVITY}"`);
  } catch (e) {
    log(`status: failed to set presence: ${e?.message}`);
  }
}

/**
 * clear the presence back to plain "online" once the run ends.
 * @param {Client | null | undefined} client - discord.js client
 * @param {(info: string) => void} [log] - logger
 * @returns {void}
 */
export function clearAgentStatus(client, log = () => {}) {
  try {
    if (!client?.user) return;
    client.user.setActivity(null);
    log("status: presence cleared");
  } catch (e) {
    log(`status: failed to clear presence: ${e?.message}`);
  }
}
