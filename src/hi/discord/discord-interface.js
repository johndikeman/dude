/**
 * Discord Human Interface
 * Handles Discord interactions via discord.js
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import fs from "fs";
import path from "path";
import { HumanInterface } from "../base-interface.js";

const getPaths = () => {
  const configDir = process.env.DUDE_CONFIG_DIR || process.cwd();
  return {
    configDir,
    tasksFile: path.join(configDir, "tasks.md"),
    configFile: path.join(configDir, "config.json"),
    logFile: path.join(configDir, "agent.log"),
  };
};

function log(msg) {
  const { logFile } = getPaths();
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(logFile, line + "\n");
  } catch (e) {}
}

export class DiscordInterface extends HumanInterface {
  constructor(config = {}) {
    super({
      ...config,
      name: "discord",
      token: config.token || process.env.DISCORD_TOKEN,
      applicationId: config.applicationId,
    });

    this.client = null;
    this.commandsRegistered = false;
    this.lastChannelId = null;
    this.callbacks = {
      ...this.callbacks,
      onCommand: [],
    };
    this.sessionMapping = new Map();
  }

  /**
   * Register a callback for command events
   * @param {Function} callback
   * @returns {DiscordInterface}
   */
  onCommand(callback) {
    this.callbacks.onCommand.push(callback);
    return this;
  }

  /**
   * Initialize the Discord client and register commands
   * @returns {Promise<void>}
   */
  async init() {
    if (!this.config.token) {
      throw new Error("Discord token not configured");
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Message],
    });

    // Handle ready event
    this.client.once("ready", () => {
      log(`Discord interface connected as ${this.client.user.tag}`);
      this.emitReady();
    });

    // Handle interactions
    this.client.on("interactionCreate", (interaction) =>
      this.handleInteraction(interaction),
    );

    // Handle messages (for replies)
    this.client.on("messageCreate", (message) => this.handleMessage(message));

    // Login to Discord
    await this.client.login(this.config.token);
  }

  /**
   * Register slash commands
   * @returns {Promise<void>}
   */
  async registerCommands() {
    if (!this.client || this.commandsRegistered) return;

    const commands = this.getSlashCommands();

    const rest = new REST({ version: "10" }).setToken(this.config.token);
    try {
      log("Refreshing Discord application commands...");
      await rest.put(Routes.applicationCommands(this.client.user.id), {
        body: commands,
      });
      this.commandsRegistered = true;
      log("Discord commands registered successfully");
    } catch (error) {
      log(`Error registering Discord commands: ${error}`);
      throw error;
    }
  }

  /**
   * Get the slash command definitions
   * @returns {Array<Object>}
   */
  getSlashCommands() {
    return [
      new SlashCommandBuilder()
        .setName("task")
        .setDescription("Add a new task to the queue")
        .addStringOption((option) =>
          option
            .setName("description")
            .setDescription("The task description")
            .setRequired(true),
        )
        .addAttachmentOption((option) =>
          option
            .setName("file")
            .setDescription("Optional text file attachment")
            .setRequired(false),
        ),
      new SlashCommandBuilder()
        .setName("start")
        .setDescription("Start processing the next task"),
      new SlashCommandBuilder()
        .setName("tasks")
        .setDescription("List all pending tasks"),
      new SlashCommandBuilder()
        .setName("status")
        .setDescription("Show current status and queue"),
      new SlashCommandBuilder()
        .setName("sessions")
        .setDescription("List active sessions"),
      new SlashCommandBuilder()
        .setName("resume")
        .setDescription("Resume a task with feedback")
        .addStringOption((option) =>
          option
            .setName("session-id")
            .setDescription("The session ID to resume")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("feedback")
            .setDescription("Feedback for resumption")
            .setRequired(false),
        ),
    ].map((cmd) => cmd.toJSON());
  }

  /**
   * Handle Discord interaction events
   * @param {Object} interaction - The Discord interaction
   * @returns {Promise<void>}
   */
  async handleInteraction(interaction) {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, options } = interaction;

    switch (commandName) {
      case "task":
        await this.handleTaskCommand(interaction, options);
        break;
      default:
        // Let registered handlers handle other commands
        for (const cb of this.callbacks.onCommand) {
          if (await cb(commandName, interaction, options)) return;
        }

        // Fallback to internal handlers if not handled
        switch (commandName) {
          case "start":
            await this.handleStartCommand(interaction);
            break;
          case "tasks":
            await this.handleTasksCommand(interaction);
            break;
          case "status":
            await this.handleStatusCommand(interaction);
            break;
          case "sessions":
            await this.handleSessionsCommand(interaction);
            break;
          case "resume":
            await this.handleResumeCommand(interaction, options);
            break;
        }
    }
  }

  /**
   * Handle /task command
   * @param {Object} interaction - The Discord interaction
   * @param {Object} options - Command options
   * @returns {Promise<void>}
   */
  async handleTaskCommand(interaction, options) {
    let task = options.getString("description");
    const attachment = options.getAttachment("file");

    if (attachment) {
      task += await this.processAttachment(attachment);
    }

    await interaction.reply({
      content: `Task added: ${this.truncate(task, 100)}`,
      ephemeral: true,
    });

    // Handle the task via the base class method
    await this.handleTask(task, {
      attachment,
      sourceInterface: "discord",
      interaction,
    });
  }

  /**
   * Handle /start command
   * @param {Object} interaction - The Discord interaction
   * @returns {Promise<void>}
   */
  async handleStartCommand(interaction) {
    await interaction.reply({
      content: "Starting task processing...",
      fetchReply: true,
    });
    this.emit("start", interaction);
  }

  /**
   * Handle /tasks command
   * @param {Object} interaction - The Discord interaction
   * @returns {Promise<void>}
   */
  async handleTasksCommand(interaction) {
    // Delegate to main agent for task listing
    const tasks = this.getPendingTasks();
    if (tasks.length === 0) {
      await interaction.reply("No pending tasks.");
    } else {
      const list = tasks
        .map((t, i) => `${i + 1}. ${this.truncate(t, 80)}`)
        .join("\n");
      await interaction.reply(`**Pending Tasks**:\n${list}`);
    }
  }

  /**
   * Handle /status command
   * @param {Object} interaction - The Discord interaction
   * @returns {Promise<void>}
   */
  async handleStatusCommand(interaction) {
    const status = {
      interface: "discord",
      isActive: this.isActive,
      lastChannelId: this.lastChannelId,
      activeSessions: this.getActiveSessions(),
    };
    await interaction.reply(
      `**Status**:\n\`\`\`${JSON.stringify(status, null, 2)}\`\`\``,
    );
  }

  /**
   * Handle /sessions command
   * @param {Object} interaction - The Discord interaction
   * @returns {Promise<void>}
   */
  async handleSessionsCommand(interaction) {
    const sessions = this.getActiveSessions();
    if (sessions.length === 0) {
      await interaction.reply("No active sessions.");
    } else {
      const list = sessions
        .map(
          (s) =>
            `[${s.sessionId}] ${this.truncate(s.task, 50)}\n  ${s.messageId ? "Replies enabled" : "No replies yet"}`,
        )
        .join("\n\n");
      await interaction.reply(`**Active Sessions**:\n${list}`);
    }
  }

  /**
   * Handle /resume command
   * @param {Object} interaction - The Discord interaction
   * @param {Object} options - Command options
   * @returns {Promise<void>}
   */
  async handleResumeCommand(interaction, options) {
    const sessionId = options.getString("session-id");
    const feedback = options.getString("feedback") || "Resume this session";

    await interaction.reply({
      content: `Resuming session ${sessionId} with feedback...`,
      ephemeral: true,
    });

    await this.handleFeedback(feedback, {
      sessionId,
      sourceInterface: "discord",
      interaction,
    });
  }

  /**
   * Handle Discord message events
   * @param {Object} message - The Discord message
   * @returns {Promise<void>}
   */
  async handleMessage(message) {
    // Ignore bot messages
    if (message.author.bot) return;

    // Update last channel
    this.lastChannelId = message.channelId;

    // Check if this is a reply to our bot's message
    const referencedMessage = message.reference
      ? await message.fetchReference().catch(() => null)
      : null;

    if (!referencedMessage || !referencedMessage.author?.bot) return;

    // Check if this references a known session
    const sessionInfo = this.getSessionByMessageId(referencedMessage.id);
    if (sessionInfo) {
      log(
        `Received feedback on session ${sessionInfo.sessionId}: ${message.content}`,
      );

      // Store the new message ID for this session
      this.storeMessageId(message.id);
      this.storeSessionMessageId(sessionInfo.sessionId, message.id);

      // Handle the feedback
      await this.handleFeedback(message.content, {
        sessionId: sessionInfo.sessionId,
        messageId: message.id,
        channelId: message.channelId,
        originalMessageId: referencedMessage.id,
      });
    }
  }

  /**
   * Send a message to the user
   * @param {string} message - The message content
   * @param {Object} [options={}] - Message options
   * @returns {Promise<Object>} The sent message
   */
  async sendMessage(message, options = {}) {
    const { channelId, messageId, embeds } = options;

    if (!this.client) {
      throw new Error("Discord client not initialized");
    }

    let channel;
    if (channelId) {
      channel = await this.client.channels.fetch(channelId);
    } else if (this.lastChannelId) {
      channel = await this.client.channels.fetch(this.lastChannelId);
    } else {
      throw new Error("No channel available to send message");
    }

    if (!channel?.isTextBased()) {
      throw new Error("Target channel is not text-based");
    }

    const fullMessage = `[Agent] ${message}`;

    try {
      const sentMessage = await channel.send({
        content: fullMessage,
        embeds,
      });

      // Store message ID for reply tracking
      if (options.storeMessageId !== false) {
        this.storeMessageId(sentMessage.id);
      }

      return sentMessage;
    } catch (err) {
      log(`Failed to send Discord message: ${err.message}`);
      throw err;
    }
  }

  /**
   * Send an editable status update
   * @param {string} message - The message content
   * @param {Object} [options={}] - Update options
   * @returns {Promise<Object>} The updated message
   */
  async sendStatusUpdate(message, options = {}) {
    const { channelId, messageId } = options;

    if (!this.client) {
      throw new Error("Discord client not initialized");
    }

    try {
      let targetMessage;

      if (messageId) {
        const channel = await this.client.channels.fetch(channelId);
        targetMessage = await channel.messages.fetch(messageId);
      } else if (this.lastChannelId && this.config.lastMessageId) {
        const channel = await this.client.channels.fetch(this.lastChannelId);
        targetMessage = await channel.messages.fetch(this.config.lastMessageId);
      }

      if (targetMessage) {
        const fullMessage = `[Agent] ${this.truncate(message, 1900)}`;
        await targetMessage.edit(fullMessage);
        return targetMessage;
      }

      // If no previous message found, send new one
      return await this.sendMessage(message, options);
    } catch (err) {
      log(`Failed to update status: ${err.message}`);
      throw err;
    }
  }

  /**
   * Store a session's current message ID for reply tracking
   * @param {string} sessionId - The session ID
   * @param {string} messageId - The message ID
   */
  storeSessionMessageId(sessionId, messageId) {
    if (!this.sessionMapping.has(sessionId)) {
      this.sessionMapping.set(sessionId, {
        sessionId,
        messageId,
      });
    } else {
      this.sessionMapping.get(sessionId).messageId = messageId;
    }
    log(`Stored Discord message ID ${messageId} for session ${sessionId}`);
  }

  /**
   * Get session info by Discord message ID
   * @param {string} messageId - The message ID
   * @returns {Object|null}
   */
  getSessionByMessageId(messageId) {
    for (const [sessionId, info] of this.sessionMapping) {
      if (info.messageId === messageId) {
        return info;
      }
    }
    return null;
  }

  /**
   * Get active sessions
   * @returns {Array<Object>}
   */
  getActiveSessions() {
    return Array.from(this.sessionMapping.values()).map((info) => ({
      sessionId: info.sessionId,
      messageId: info.messageId,
    }));
  }

  /**
   * Query for latest message from a session
   * @param {string} sessionId - The session ID
   * @returns {Promise<Object|null>}
   */
  async queryLatestMessage(sessionId) {
    const sessionInfo = this.sessionMapping.get(sessionId);
    if (!sessionInfo) return null;

    try {
      const channel = await this.client.channels.fetch(this.lastChannelId);
      if (!channel?.isTextBased()) return null;

      const message = await channel.messages.fetch(sessionInfo.messageId);
      return message;
    } catch (err) {
      log(`Failed to query message for session ${sessionId}: ${err.message}`);
      return null;
    }
  }

  /**
   * Emit an event to registered handlers - legacy support
   * @param {string} event - Event name
   * @param {any} data - Event data
   * @param {Object} [options={}] - Event options
   */
  emit(event, data, options = {}) {
    if (event === "task") {
      this.handleTask(data, options);
    } else if (event === "feedback") {
      this.handleFeedback(data, options);
    } else {
      const handlers =
        this.callbacks[`on${event.charAt(0).toUpperCase() + event.slice(1)}`];
      if (handlers) {
        handlers.forEach((handler) => handler(data));
      }
    }
  }

  /**
   * Process an attachment and return its content
   * @param {Object} attachment - The Discord attachment
   * @returns {Promise<string>}
   */
  async processAttachment(attachment) {
    const isText =
      attachment.contentType?.startsWith("text/") ||
      [".txt", ".md", ".js", ".ts", ".py", ".json", ".c", ".cpp", ".h"].some(
        (ext) => attachment.name.toLowerCase().endsWith(ext),
      );

    if (!isText) return "";

    try {
      const response = await fetch(attachment.url);
      if (!response.ok)
        throw new Error(`Download failed: ${response.statusText}`);
      const text = await response.text();
      return `\n\nFile content (${attachment.name}):\n${text}`;
    } catch (err) {
      log(`Error processing attachment: ${err.message}`);
      return "";
    }
  }

  /**
   * Get pending tasks from tasks.md
   * @returns {Array<string>}
   */
  getPendingTasks() {
    const { tasksFile } = getPaths();
    if (!fs.existsSync(tasksFile)) return [];

    const content = fs.readFileSync(tasksFile, "utf8");
    const tasks = [];
    const lines = content.split("\n");
    let currentTask = null;

    for (const line of lines) {
      if (line.startsWith("- [ ] ")) {
        if (currentTask !== null) tasks.push(currentTask.trim());
        currentTask = line.slice(6);
      } else if (line.startsWith("- [x] ") || line.startsWith("#")) {
        if (currentTask !== null) {
          tasks.push(currentTask.trim());
          currentTask = null;
        }
      } else if (currentTask !== null) {
        currentTask += "\n" + line.replace(/^  /, "");
      }
    }
    if (currentTask !== null) tasks.push(currentTask.trim());

    return [...new Set(tasks)];
  }

  /**
   * Helper to truncate text
   * @param {string} str - String to truncate
   * @param {number} [limit=2000] - Character limit
   * @returns {string}
   */
  truncate(str, limit = 2000) {
    if (!str) return "";
    if (str.length <= limit) return str;
    return str.slice(0, limit - 3) + "..";
  }

  /**
   * Stop the interface
   * @returns {Promise<void>}
   */
  async stop() {
    this.stopPolling();
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    this.isActive = false;
  }
}
