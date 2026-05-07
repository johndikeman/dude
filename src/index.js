/**
 * Dude Agent - Modular Architecture Main Entry Point
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { 
  InterfaceManager, 
  DiscordInterface, 
  GitHubInterface, 
  LichessInterface,
  ManagerAgent
} from "./modular-agent.js";

import * as SCHEDULER from "./scheduler.js";

const getPaths = () => {
  const configDir = process.env.DUDE_CONFIG_DIR || process.cwd();
  return {
    configDir,
    logFile: path.join(configDir, "agent.log"),
    sessionsFile: path.join(configDir, "sessions.json"),
    tasksFile: path.join(configDir, "tasks.md"),
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

class DudeApp {
  constructor() {
    this.interfaceManager = new InterfaceManager();
    this.activeManagerSessions = new Map(); // sessionId -> ManagerAgent
  }

  async start() {
    log("Starting Dude Agent with modular architecture...");

    // 1. Initialize Human Interfaces
    const discord = new DiscordInterface({
      token: process.env.DISCORD_TOKEN,
      applicationId: process.env.DISCORD_APPLICATION_ID,
    });

    const github = new GitHubInterface({
      repo: process.env.GITHUB_REPO,
    });

    const lichess = new LichessInterface({
      apiKey: process.env.LICHESS_API_KEY,
    });

    this.interfaceManager.register(discord);
    this.interfaceManager.register(github);
    this.interfaceManager.register(lichess);

    // 2. Setup Event Handlers
    this.setupHandlers();

    // 3. Start all interfaces
    await this.interfaceManager.startAll();
    
    // Register Discord commands if needed
    if (discord.isActive) {
      await discord.registerCommands();
    }
    
    // Start polling for interfaces that need it
    github.startPolling();
    lichess.startPolling();

    // Start polling for scheduled tasks
    this.startSchedulerPolling();

    // Start polling for agent messages (from CLI tool)
    this.startMessageQueuePolling();

    // Handle commands from Discord
    if (discord.isActive) {
      discord.onCommand(async (command, interaction, options) => {
        return await this.handleDiscordCommand(command, interaction, options);
      });
    }

    log("Dude Agent is ready");
  }

  async handleDiscordCommand(command, interaction, options) {
    switch (command) {
      case "tasks":
        const tasks = this.getPendingTasks();
        if (tasks.length === 0) {
          await interaction.reply("No pending tasks.");
        } else {
          await interaction.reply(`**Pending Tasks:**\n${tasks.map((t, i) => `${i + 1}. ${t.substring(0, 100)}`).join("\n")}`);
        }
        return true;

      case "sessions":
        const sessions = Array.from(this.activeManagerSessions.values());
        if (sessions.length === 0) {
          await interaction.reply("No active sessions.");
        } else {
          await interaction.reply(`**Active Sessions:**\n${sessions.map(s => `[${s.sessionId}] ${s.task.substring(0, 50)} (${s.phase})`).join("\n")}`);
        }
        return true;

      case "status":
        const paused = SCHEDULER.listPausedTasks();
        const statusLines = [
          `**Dude Agent Status**`,
          `Active Sessions: ${this.activeManagerSessions.size}`,
          `Pending Tasks: ${this.getPendingTasks().length}`,
          `Paused Tasks: ${paused.length}`
        ];
        if (paused.length > 0) {
          statusLines.push(`Next resumption: ${paused[0].resumeAt}`);
        }
        await interaction.reply(statusLines.join("\n"));
        return true;

      case "workdir":
        const newDir = options.getString("path");
        if (fs.existsSync(newDir)) {
          process.env.DUDE_WORK_DIR = path.resolve(newDir);
          await interaction.reply(`Working directory updated to: ${process.env.DUDE_WORK_DIR}`);
        } else {
          await interaction.reply(`Directory does not exist: ${newDir}`);
        }
        return true;

      case "audit":
        await interaction.deferReply();
        try {
          // This would need a modular implementation of audit.js
          await interaction.editReply("Self-audit not yet implemented in modular architecture.");
        } catch (err) {
          await interaction.editReply(`Audit failed: ${err.message}`);
        }
        return true;
    }
    return false;
  }

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

  startMessageQueuePolling() {
    const { messageQueueFile } = getPaths();
    setInterval(async () => {
      if (!fs.existsSync(messageQueueFile)) return;

      try {
        const content = fs.readFileSync(messageQueueFile, "utf8");
        fs.writeFileSync(messageQueueFile, ""); // Clear queue

        const lines = content.split("\n").filter(l => l.trim());
        for (const line of lines) {
          const entry = JSON.parse(line);
          log(`Message from queue: ${entry.message}`);
          
          if (entry.sessionId) {
            const manager = this.activeManagerSessions.get(entry.sessionId);
            if (manager) {
              await manager.notifyUser(entry.message);
              continue;
            }
          }

          // Fallback: broadcast to all interfaces
          await this.interfaceManager.broadcast(entry.message);
        }
      } catch (err) {
        log(`Error polling message queue: ${err.message}`);
      }
    }, 5000);
  }

  startSchedulerPolling() {
    setInterval(async () => {
      const ready = SCHEDULER.getReadyTasks();
      
      if (ready.paused.length > 0) {
        for (const task of ready.paused) {
          log(`Resuming paused task: ${task.task}`);
          await this.resumePausedTask(task);
        }
        SCHEDULER.removeCompletedTasks(ready.paused.map(t => t.id));
      }

      if (ready.scheduled.length > 0) {
        for (const task of ready.scheduled) {
          log(`Running scheduled task: ${task.task}`);
          await this.handleNewTask(task.task, { sourceInterface: "discord" }); // Default to discord
        }
        SCHEDULER.removeCompletedTasks(ready.scheduled.map(t => t.id));
      }
    }, 60000); // Check every minute
  }

  async resumePausedTask(task) {
    const { sessionInfo } = task;
    const sessionId = sessionInfo?.sessionId || task.id;
    
    // Check if we already have this session active
    let manager = this.activeManagerSessions.get(sessionId);
    
    if (manager) {
      await manager.resume("Quota reset. Please continue with the task.");
    } else {
      log(`Re-creating manager for session ${sessionId}`);
      await this.handleNewTask(task.task, { 
        sessionId,
        ...sessionInfo,
        sourceInterface: sessionInfo?.sourceInterface || "discord"
      });
    }
  }

  setupHandlers() {
    // Handle new tasks from any interface
    this.interfaceManager.getAll().forEach(iface => {
      iface.onTaskReceived(async (task, options) => {
        log(`Received task from ${iface.name}: ${task.substring(0, 50)}...`);
        await this.handleNewTask(task, { ...options, sourceInterface: iface.name });
      });

      iface.onFeedbackReceived(async (feedback, context) => {
        log(`Received feedback from ${iface.name} for session ${context.sessionId}`);
        await this.handleFeedback(feedback, context);
      });
    });
  }

  async handleNewTask(task, options) {
    const sessionId = options.sessionId || `manager-${Date.now()}`;
    const workspacePath = process.env.DUDE_WORK_DIR || process.cwd();

    if (this.activeManagerSessions.has(sessionId)) {
      log(`Session ${sessionId} already active, not creating new one`);
      return;
    }

    log(`Creating manager agent for session ${sessionId}`);

    const manager = new ManagerAgent({
      sessionId,
      task,
      workspacePath,
      githubInterface: this.interfaceManager.get("github"),
      sourceInterface: options.sourceInterface,
      discordMessageId: options.discordMessageId || options.interaction?.id || options.messageId,
      discordChannelId: options.discordChannelId || options.interaction?.channelId || options.channelId,
      onStatusUpdate: (status) => {
        // Update status in the source interface if supported
        const iface = this.interfaceManager.get(options.sourceInterface);
        if (iface && iface.sendStatusUpdate) {
          iface.sendStatusUpdate(`Status: ${status}`, {
            channelId: options.interaction?.channelId || options.channelId,
            messageId: options.interaction?.id || options.messageId,
          });
        }
      },
      onQuotaExhausted: (quotaInfo) => {
        log(`Quota exhausted for session ${sessionId}, pausing task`);
        SCHEDULER.pauseTask(task, quotaInfo, manager.getSessionInfo());
        
        const iface = this.interfaceManager.get(options.sourceInterface);
        if (iface) {
          iface.sendMessage(`Task paused due to quota exhaustion. Will resume in approximately ${Math.round(quotaInfo.resetAfterMs / 60000)} minutes.`);
        }
      },
      messageCallback: async (type, message, data) => {
        // Send message back to user via source interface
        const iface = this.interfaceManager.get(options.sourceInterface);
        if (iface) {
          const sentMessage = await iface.sendMessage(message, {
            channelId: options.interaction?.channelId || options.channelId,
            // If it's a plan ready notification, we want to track the message ID
            // so we can identify replies to it.
            storeMessageId: true,
          });
          
          if (sentMessage && sentMessage.id) {
            iface.storeSessionMessageId(sessionId, sentMessage.id);
          }
        }
      }
    });

    this.activeManagerSessions.set(sessionId, manager);
    
    try {
      await manager.run();
    } catch (err) {
      log(`Error running manager agent ${sessionId}: ${err.message}`);
      this.activeManagerSessions.delete(sessionId);
    }
  }

  async handleFeedback(feedback, context) {
    const { sessionId } = context;
    const manager = this.activeManagerSessions.get(sessionId);

    if (manager) {
      log(`Resuming manager session ${sessionId} with feedback`);
      await manager.resume(feedback);
    } else {
      log(`No active manager session found for ID ${sessionId}`);
      // Maybe try to restore from file?
    }
  }
}

const app = new DudeApp();
app.start().catch(err => {
  console.error("Fatal error starting app:", err);
  process.exit(1);
});
