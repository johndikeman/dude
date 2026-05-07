/**
 * Discord Extensions - Pi agent extensions for Discord-specific functionality
 */

export class DiscordExtensions {
  /**
   * Create a Discord message extension
   * Allows agents to send messages back to the user
   * @param {string} sessionId - The session ID
   * @param {Object} discordInterface - The Discord interface instance
   * @returns {Object} Pi extension object
   */
  static createMessageExtension(sessionId, discordInterface) {
    return {
      name: "discord-message",
      description: "Send messages back to the Discord user",
      tools: [
        {
          name: "send_discord_message",
          description: "Send a message back to the user on Discord for feedback, clarification, or plan approval.",
          parameters: {
            type: "object",
            properties: {
              message: {
                type: "string",
                description: "The message to send to the user",
              },
            },
            required: ["message"],
          },
          execute: async ({ message }) => {
            try {
              // Try to get the latest message ID for this session to reply to it
              const sessionInfo = discordInterface.sessionMapping.get(sessionId);
              const options = {};
              
              if (sessionInfo && sessionInfo.messageId) {
                // If we have a message ID, we could potentially reply or just use the same channel
                // For now, sendMessage uses lastChannelId if none provided
              }

              const sentMessage = await discordInterface.sendMessage(message, options);
              
              // Store the new message ID for future replies
              if (sentMessage) {
                discordInterface.storeSessionMessageId(sessionId, sentMessage.id);
              }

              return { success: true, messageId: sentMessage?.id };
            } catch (err) {
              return { success: false, error: err.message };
            }
          },
        },
      ],
    };
  }
}
