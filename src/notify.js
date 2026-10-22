// discord pings for non-discord-triggered runs.
// john: "when starting on a task other than a discord triggered one, ping
// on discord when its started and finished." scheduled cron runs and
// wait-fired --once runs (including purposes) used to run completely
// silent — john only found out a run happened by reading the vault hours
// later. this module posts a short start + finish message to a notify
// channel.
//
// the long-running discord service already has a logged-in client — reuse
// it. the --once processes (cron + wait-fired, incl. purposes) never call
// client.login(), so here we lazily create a minimal client, login, send,
// destroy. every step is best-effort: a discord hiccup must never delay
// or crash a run.

import fs from "fs";
import path from "path";
import { Client, GatewayIntentBits } from "discord.js";

const LAZY_LOGIN_TIMEOUT_MS = 15_000;
const LAZY_SEND_TIMEOUT_MS = 15_000;

/** hard discord message cap (2000) minus a safety margin */
const MAX_MESSAGE_LEN = 1900;

/** start-of-run notification text. context summaries are truncated to fit. */
export function startedMessage({ trigger, purpose, context }) {
  const bits = [];
  if (purpose) bits.push(`purpose: ${purpose}`);
  if (context?.summary) bits.push(String(context.summary).slice(0, 1200));
  let msg = `▶️ dude run starting (${trigger}${bits.length ? ` — ${bits.join("; ")}` : ""})`;
  return msg.length > MAX_MESSAGE_LEN ? msg.slice(0, MAX_MESSAGE_LEN) : msg;
}

/** end-of-run notification text. everything truncated to fit discord's cap. */
export function finishedMessage({ outcome, summary, err, sessionFile }) {
  let head;
  switch (outcome) {
    case "ok":
      head = "✅ dude run finished";
      break;
    case "loop-abort":
      head = "🛑 dude run aborted by tool-loop breaker";
      break;
    case "failed":
      head = "❌ dude run failed";
      break;
    default:
      head = "⚪ dude run ended";
  }
  let msg = head;
  if (err) msg += `\nerror: ${String(err).slice(0, 600)}`;
  if (sessionFile) msg += `\nsession: ${sessionFile}`;
  if (summary) {
    const budget = MAX_MESSAGE_LEN - msg.length - 1;
    if (budget > 0) msg += `\n${String(summary).slice(0, budget)}`;
  }
  return msg;
}

/**
 * resolve the channel id to notify: DUDE_NOTIFY_CHANNEL_ID env first,
 * falling back to the pi config's lastChannelId (the channel john last
 * talked to the bot in).
 * @param {{configDir?: string}} [paths]
 * @returns {string | null}
 */
export function resolveNotifyChannelId(paths = {}) {
  const envId = process.env.DUDE_NOTIFY_CHANNEL_ID;
  if (envId) return envId;
  const configDir = paths.configDir || process.env.DUDE_CONFIG_DIR;
  if (!configDir) return null;
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(configDir, "config.json"), "utf8"),
    );
    return cfg.lastChannelId || null;
  } catch {
    return null;
  }
}

/**
 * send one notification message. returns the sent Message (or null).
 * uses existingClient when logged in; otherwise creates a throwaway
 * minimal client, logs in, sends, destroys.
 * @param {object} opts
 * @param {import('discord.js').Client} [opts.existingClient] - the
 *   long-running service's client, if we're inside it
 * @param {string} opts.content - message body
 * @param {{configDir?: string}} [opts.paths]
 * @param {(info: string) => void} [opts.log]
 * @returns {Promise<import('discord.js').Message | null>}
 */
export async function sendNotify({
  existingClient,
  content,
  paths = {},
  log = () => {},
} = {}) {
  if (!content) return null;
  const channelId = resolveNotifyChannelId(paths);
  if (!channelId) {
    log("notify: no channel id (DUDE_NOTIFY_CHANNEL_ID / config.json); skipping");
    return null;
  }
  // fast path: the service client is already logged in
  if (existingClient?.user) {
    return sendVia(existingClient, channelId, content, log);
  }
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    log("notify: no DISCORD_TOKEN; skipping");
    return null;
  }
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    await loginWithTimeout(client, token, log);
    return await sendVia(client, channelId, content, log);
  } catch (e) {
    log(`notify: send failed: ${e?.message || e}`);
    return null;
  } finally {
    try {
      await client.destroy();
    } catch { /* nothing */ }
  }
}

async function loginWithTimeout(client, token, log) {
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("notify: discord login timed out")),
      LAZY_LOGIN_TIMEOUT_MS,
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
  await client.login(token);
  await ready;
}

async function sendVia(client, channelId, content, log) {
  const send = (async () => {
    const channel = await client.channels.fetch(channelId);
    if (!channel || typeof channel.send !== "function") {
      throw new Error(`channel ${channelId} not sendable`);
    }
    return channel.send(content);
  })();
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("notify: send timed out")), LAZY_SEND_TIMEOUT_MS),
  );
  try {
    return await Promise.race([send, timeout]);
  } catch (e) {
    log(`notify: send failed: ${e?.message || e}`);
    return null;
  }
}
