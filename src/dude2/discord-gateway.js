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
  client.on("messageCreate", (message) => {
    if (message.author?.bot) return;
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
