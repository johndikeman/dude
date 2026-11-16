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
  // filled after login — used to tell "a tag for THIS bot" apart from
  // a tag for any other bot sharing the channel (live bug 2026-11-15:
  // tags to dude 1 triggered dude 2 runs because nothing filtered them)
  let ownBotId = null;

  client.on("messageCreate", (message) => {
    if (message.author?.bot) return;
    const mentionedUs =
      !!ownBotId &&
      (message.mentions?.users?.has(ownBotId) ||
        (message.content || "").includes(`<@${ownBotId}>`));
    const isDm = !!message.channel?.isDMBased?.();
    const info = {
      channelId: message.channel?.id ?? message.channelId,
      content: message.content,
      messageId: message.id,
      mentionedUs,
      isDm,
    };
    messages.push(info);
    onMessage?.(info);
  });

  // discord.js v14 renamed `ready` to `clientReady` (both emitted for now)
  client.once(client.Events?.ClientReady ?? "ready", () => {
    ownBotId = client.user?.id ?? null;
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
