#!/usr/bin/env node
import "dotenv/config";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import stripAnsi from "strip-ansi";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message],
});

const getPaths = () => {
  const configDir = process.env.DUDE_CONFIG_DIR || process.cwd();
  const obsidianDir = process.env.OBSIDIAN_DIR || process.cwd();
  return {
    configDir,
    tasksFile: path.join(obsidianDir, "ai-tasks.md"),
    configFile: path.join(configDir, "config.json"),
    logFile: path.join(configDir, "agent.log"),
    repoBriefFile: path.join(process.cwd(), "REPO_BRIEF.md"),
  };
};

// Model configuration - loaded from config file
let MODEL_CODE = null;
let MODEL_PROVIDER = null;
let FALLBACK_MODEL_CODE = null;
let FALLBACK_MODEL_PROVIDER = null;
let USE_FALLBACK_ON_QUOTA_ERROR = false;

function log(msg) {
  const { logFile } = getPaths();
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(logFile, line + "\n");
  } catch (e) {}
}

let config = {
  workDir: process.cwd(),
  autoNext: false,
  statusUpdateInterval: 120000, // 2 minutes in ms
  statusUpdateModel: "gemini-2.0-flash",
  lastChannelId: null,
  modelCode: "gemini-3-flash-preview", // default model
  modelProvider: "google-gemini-cli",
  fallbackModelCode: null, // optional fallback model for quota errors
  fallbackModelProvider: null,
  useFallbackOnQuotaError: false, // flag to enable fallback on quota errors
};

let isRunning = false;
let currentRunningTask = null;
let pausedTaskInfo = null; // Store info about paused tasks for status display

if (fs.existsSync(getPaths().configFile)) {
  try {
    const savedConfig = JSON.parse(
      fs.readFileSync(getPaths().configFile, "utf8"),
    );
    config = { ...config, ...savedConfig };
  } catch (e) {
    log(`Error loading config: ${e.message}`);
  }
}

// Initialize model settings from config
function initializeModelSettings() {
  MODEL_CODE = config.modelCode || "gemini-3-flash-preview";
  MODEL_PROVIDER = config.modelProvider || "google-gemini-cli";
  FALLBACK_MODEL_CODE = config.fallbackModelCode || null;
  FALLBACK_MODEL_PROVIDER = config.fallbackModelProvider || null;
  USE_FALLBACK_ON_QUOTA_ERROR = config.useFallbackOnQuotaError || false;

  // Determine fallback provider if not explicitly set
  if (FALLBACK_MODEL_CODE && !FALLBACK_MODEL_PROVIDER) {
    if (FALLBACK_MODEL_CODE === "qwen3.5:122b") {
      FALLBACK_MODEL_PROVIDER = "verda";
    } else {
      FALLBACK_MODEL_PROVIDER = "google-gemini-cli";
    }
  }

  // Determine main provider if not explicitly set
  if (!MODEL_PROVIDER) {
    if (MODEL_CODE === "qwen3.5:122b") {
      MODEL_PROVIDER = "verda";
    } else {
      MODEL_PROVIDER = "google-gemini-cli";
    }
  }

  log(`Initialized model: ${MODEL_CODE} (${MODEL_PROVIDER})`);
  if (USE_FALLBACK_ON_QUOTA_ERROR && FALLBACK_MODEL_CODE) {
    log(
      `Fallback model enabled: ${FALLBACK_MODEL_CODE} (${FALLBACK_MODEL_PROVIDER})`,
    );
  }
}

function saveConfig() {
  // Update global model settings from config before saving
  config.modelCode = MODEL_CODE;
  config.modelProvider = MODEL_PROVIDER;
  config.fallbackModelCode = FALLBACK_MODEL_CODE;
  config.fallbackModelProvider = FALLBACK_MODEL_PROVIDER;
  config.useFallbackOnQuotaError = USE_FALLBACK_ON_QUOTA_ERROR;
  fs.writeFileSync(getPaths().configFile, JSON.stringify(config, null, 2));
}

client.once("ready", async () => {
  log(`Logged in as ${client.user.tag}!`);
  log(`Current working directory: ${config.workDir}`);

  // Initialize model settings from config
  initializeModelSettings();
});

client.on("messageCreate", async (message) => {
  // Ignore bot messages
  if (message.author.bot) return;

  // Store channel ID for autoNext status updates
  if (message.channelId && config.lastChannelId !== message.channelId) {
    config.lastChannelId = message.channelId;
    saveConfig();
  }

  // Check if this is a reply to a bot message
  const referencedMessage = message.reference
    ? await message.fetchReference().catch(() => null)
    : null;

  // or if user directly tagged the bot
  const taggedBotDirectly = message.mentions.members
    .keys()
    .includes(client.user.id);

  if (
    !referencedMessage ||
    !referencedMessage.author?.bot ||
    !taggedBotDirectly
  )
    return;
});

async function runCycle(interaction, initialStatusMessage = null) {
  if (isRunning) {
    if (interaction) interaction.followUp("A task is already being processed.");
    return;
  }

  const tasks = getPendingTasks();
  if (tasks.length === 0) {
    if (interaction) interaction.followUp("No pending tasks.");
    return;
  }

  isRunning = true;
  let task = tasks[0];
  currentRunningTask = task;
  log(`Working on task: ${task}`);

  // Check if this is a fallback retry task
  let isFallbackRetry = false;
  let originalTask = task;
  let previousError = "";
  if (task.startsWith("[FALLBACK_RETRY]")) {
    isFallbackRetry = true;
    // Extract original task and error
    const match = task.match(
      /\[FALLBACK_RETRY\]\s*Original:\s*(.+?)\s*Previous error:\s*(.+)/s,
    );
    if (match) {
      originalTask = match[1].trim();
      previousError = match[2].trim();
      task = originalTask;
    }
    log(`Fallback retry enabled. Using fallback model: ${FALLBACK_MODEL_CODE}`);
  }

  // Switch to fallback model if this is a retry task
  if (isFallbackRetry && USE_FALLBACK_ON_QUOTA_ERROR && FALLBACK_MODEL_CODE) {
    MODEL_CODE = FALLBACK_MODEL_CODE;
    MODEL_PROVIDER = FALLBACK_MODEL_PROVIDER || "google-gemini-cli";
    log(`Switched to fallback model: ${MODEL_CODE} (${MODEL_PROVIDER})`);
  }

  const prompt = `You are a self-improving AI agent named "dude".
Current date: ${new Date().toLocaleString("en-US")}
Your goal is to implement the tasks/goals laid out for you in ${getPaths().tasksFile}. 
your workspace is in (${config.workDir}).
you have access to the gh cli, an obsidian vault, and the vps you're running in.
if the task is to improve yourself, this will be in the dude/ directory. if the directory does not exist, you can use the gh cli to clone johndikeman/dude.
you can clone other repositories if needed.
Create a feature branch to work on, REMEMBER TO ALWAYS FIRST pull in the most recent 'main' branch and use it as the base of your feature branch in case another user has made changes, to avoid a merge conflict.
when appropriate, write testcases to test new code.
Then, commit the code to the feature branch and open a PR using gh cli.
When the task is complete, mark it as done in the task file (${getPaths().tasksFile}) by changing [ ] to [x]. PREFER USING YOUR EDIT TOOL FOR THIS intead of sed which is prone to failure.
Please add output summarizing the work completed to the files referenced for each particular task.

if needed, previous sessions can be found in ~/.pi/agent/sessions/
use lowercase writing and a semi-informal tone.

Context:
- Task File: ${getPaths().tasksFile}
- Current working directory: ${config.workDir}
`;

  let piOutput = "";
  let piError = "";
  let lastAssistantMessage = "";
  let statusMessage = initialStatusMessage;
  let currentSessionId = null;
  let lastStatusUpdate = 0;
  const UPDATE_INTERVAL = 5000;
  let currentStatus = "Starting...";
  let pausedTaskId = null;
  let quotaErrorHandled = false;

  const piArgs = [
    "--provider",
    MODEL_PROVIDER,
    "--model",
    MODEL_CODE,
    "--mode",
    "json",
    prompt,
  ];

  if (process.env.PI_SKILLS) {
    piArgs.push("--skill", process.env.PI_SKILLS);
  }

  log(`Executing: pi ${piArgs.join(" ")} in ${config.workDir}`);

  const piProcess = spawn("pi", piArgs, {
    stdio: ["inherit", "pipe", "pipe"],
    cwd: config.workDir,
  });

  piProcess.on("error", async (err) => {
    isRunning = false;
    currentRunningTask = null;
    pausedTaskInfo = null;
    log(`Failed to start pi process: ${err.message}`);
    currentStatus = `Failed to start.`;
    await updateDiscordStatus(true);
    if (interaction)
      interaction.followUp(`Failed to start pi process: ${err.message}`);
  });

  if (!statusMessage) {
    let statusContent = `**Current Task:** ${task}\n**Status:** ${currentStatus}`;
    if (statusContent.length > 2000) {
      statusContent = statusContent.slice(0, 1990) + "... (truncated)";
    }
    if (interaction) {
      statusMessage = await interaction.followUp({
        content: statusContent,
        fetchReply: true,
      });
    } else if (config.lastChannelId) {
      try {
        const channel = await client.channels.fetch(config.lastChannelId);
        if (channel && channel.isTextBased()) {
          statusMessage = await channel.send(statusContent);
        }
      } catch (e) {
        log(`Failed to send auto-next status message: ${e.message}`);
      }
    }
  }

  const updateDiscordStatus = async (force = false) => {
    if (!statusMessage) return;
    const now = Date.now();
    if (force || now - lastStatusUpdate > UPDATE_INTERVAL) {
      lastStatusUpdate = now;
      try {
        let statusContent = `**Current Task:** ${task}\n**Status:** ${currentStatus}`;
        if (statusContent.length > 2000) {
          statusContent = statusContent.slice(0, 1990) + "... (truncated)";
        }
        await statusMessage.edit(statusContent);
      } catch (e) {
        log(`Failed to update Discord status: ${e.message}`);
      }
    }
  };

  piProcess.on("close", async (code) => {
    isRunning = false;
    currentRunningTask = null;
    // Check if this was a quota pause
    if (code === 0) {
      log("pi finished successfully.");

      if (interaction) {
        const finalResponse = lastAssistantMessage || piOutput;
        const cleanedOutput = stripAnsi(finalResponse.trim());
        const truncatedOutput =
          cleanedOutput.length > 1900
            ? "..." + cleanedOutput.slice(-1900)
            : cleanedOutput;
        interaction.followUp(
          truncatedOutput || "Task completed successfully (no output).",
        );
      } else if (statusMessage) {
        const finalResponse = lastAssistantMessage || piOutput;
        const cleanedOutput = stripAnsi(finalResponse.trim());
        const truncatedOutput =
          cleanedOutput.length > 1900
            ? "..." + cleanedOutput.slice(-1900)
            : cleanedOutput;
        statusMessage.reply(
          truncatedOutput || "Task completed successfully (no output).",
        );
      }
    } else {
      let errorMsg = `**pi failed with code ${code}**\n\n`;

      const cleanError = stripAnsi(piError.trim());
      const cleanOutput = stripAnsi(piOutput.trim());

      if (cleanError) {
        const truncatedError =
          cleanError.length > 800 ? "..." + cleanError.slice(-800) : cleanError;
        errorMsg += `**Error Output:**\n\`\`\`\n${truncatedError}\n\`\`\`\n`;
      }

      if (cleanOutput) {
        const truncatedOutput =
          cleanOutput.length > 800
            ? "..." + cleanOutput.slice(-800)
            : cleanOutput;
        errorMsg += `**Standard Output:**\n\`\`\`\n${truncatedOutput}\n\`\`\``;
      }

      if (!cleanError && !cleanOutput) {
        errorMsg += "No output or error messages were captured.";
      }

      currentStatus = `Failed with code ${code}.`;
      await updateDiscordStatus(true);

      if (interaction) {
        if (errorMsg.length > 2000) {
          errorMsg = errorMsg.slice(0, 1997) + "...";
        }
        interaction.followUp(errorMsg);
      } else if (statusMessage) {
        if (errorMsg.length > 2000) {
          errorMsg = errorMsg.slice(0, 1997) + "...";
        }
        statusMessage.reply(errorMsg);
      }
      log(`pi failed with code ${code}.`);
    }
  });
}

client.login(process.env.DISCORD_TOKEN);
