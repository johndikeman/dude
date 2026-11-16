/**
 * dude2 discord gateway — thin wrapper over discord.js for the dispatcher.
 *
 * separate from v1's client wiring so dude2 gets its own bot token
 * (op://AI/dude 2 discord token/password, injected via env by the nix
 * unit) and its own presence. the gateway only ingests messages into the
 * queue; sending replies is the run/api layer's job (phase 2).
 */

import { Client, GatewayIntentBits, Partials } from "discord.js";

/**
 * decide whether a discord message should be ingested into dude2's queue.
 * mirrors dude1's trigger rules (src/index.js): a direct tag of this bot,
 * a reply to a message authored by this bot, or any non-bot DM.
 * everything else is ignored — without this filter dude2 hijacks every
 * message in shared channels, including tags aimed at dude1.
 *
 * exported for unit testing; the real gateway calls it from messageCreate.
 */
export async function shouldIngest(clientUserId, message) {
  if (!message || message.author?.bot) return false;
  if (!message.guild) return true; // DMs always trigger
  // direct tag of this bot
  if (message.mentions?.has?.(clientUserId)) return true;
  // reply to one of our own messages (5s hard timeout, same as dude1 —
  // the REST fetchReference call can hang on rate limits)
  if (message.reference?.messageId) {
    const referenced = await Promise.race([
      message.fetchReference(),
      new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
    ]).catch(() => null);
    if (referenced?.author?.id === clientUserId) return true;
  }
  return false;
}

/**
 * create a logged-in client that calls onMessage({channelId, content,
 * messageId}) for every relevant message. returns { client, close() }.
 */
export async function createGateway(cfg, { onMessage } = {}) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message],
  });
  client.on("error", () => {}); // crash guard lives at process level

  const messages = [];
  client.on("messageCreate", async (message) => {
    if (!(await shouldIngest(client.user.id, message))) return;
    const info = {
      channelId: message.channel?.id ?? message.channelId,
      content: message.content,
      messageId: message.id,
    };
    messages.push(info);
    onMessage?.(info);
  });

  await client.login(cfg.discordToken);
  return {
    client,
    /** recorded messages (e2e/stub use) */
    messages,
    /** send a reply into a channel/thread on behalf of a run */
    sendReply: async ({ channelId, text }) => {
      const channel = await client.channels.fetch(channelId);
      await channel.send(text);
    },
    close: () => client.destroy(),
  };
}
