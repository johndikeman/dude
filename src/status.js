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

// a run wanted a presence but the gateway wasn't up yet — applied once the
// client reaches ready (see the login race in index.js: scheduled/watcher
// triggers fire runCycle immediately after client.login(), so client.user is
// usually still undefined at setAgentStatus time).
let presenceWanted = false;

/**
 * set the bot presence to show the agent is busy. no-op (logged) when
 * the discord client isn't logged in yet (scheduled runs start before
 * the gateway connection is up).
 * @param {Client | null | undefined} client - discord.js client
 * @param {(info: string) => void} [log] - logger
 * @returns {void}
 */
export function setAgentStatus(client, log = () => {}) {
  presenceWanted = true;
  try {
    if (!client?.user) {
      log(
        "status: discord client not ready; presence queued until gateway ready",
      );
      return;
    }
    client.user.setActivity(AGENT_ACTIVITY, { type: 0 /* Playing */ });
    log(`status: presence set to "Playing ${AGENT_ACTIVITY}"`);
  } catch (e) {
    log(`status: failed to set presence: ${e?.message}`);
  }
}

/**
 * apply the queued presence once the gateway is up. register once at startup
 * (before client.login()); no-op if the run ends before ready fires.
 * @param {Client} client - discord.js client
 * @param {(info: string) => void} [log] - logger
 * @returns {void}
 */
export function attachStatusReady(client, log = () => {}) {
  client.once("clientReady", () => {
    if (!presenceWanted) return;
    try {
      client.user?.setActivity(AGENT_ACTIVITY, { type: 0 /* Playing */ });
      log(`status: presence set on ready to "Playing ${AGENT_ACTIVITY}"`);
    } catch (e) {
      log(`status: failed to set presence on ready: ${e?.message}`);
    }
  });
}

/**
 * clear the presence back to plain "online" once the run ends.
 * @param {Client | null | undefined} client - discord.js client
 * @param {(info: string) => void} [log] - logger
 * @returns {void}
 */
export function clearAgentStatus(client, log = () => {}) {
  presenceWanted = false;
  try {
    if (!client?.user) return;
    client.user.setActivity(null);
    log("status: presence cleared");
  } catch (e) {
    log(`status: failed to clear presence: ${e?.message}`);
  }
}
