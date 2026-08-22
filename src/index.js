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

/** @param {string} msg - the message to log */
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
  const taggedBotDirectly = message.mentions.members.has(client.user.id);

  if (
    !referencedMessage ||
    !referencedMessage.author?.bot ||
    !taggedBotDirectly
  )
    return;
  runCycle(message);
});

/** this triggers a one-off run of the agent, separate from the periodic cron job
 * @import {OmitPartialGroupDMChannel, Message} from 'discord.js'
 @param {OmitPartialGroupDMChannel<Message<boolean>>} message - the discord message that triggered the agent run */
async function runCycle(message) {
  isRunning = true;

  const prompt = `You are a self-improving AI agent named "dude". your source code is contained in the github repository johndikeman/dude
Current date: ${new Date().toLocaleString("en-US")}
Your goal is to implement the tasks/goals laid out for you in ${getPaths().tasksFile}. 
your workspace is in (${config.workDir}).
you have access to the gh cli, an obsidian vault, a onepassword service account for credentials, and the vps you're running in.
the vps is an ubuntu server which uses nix + home-manager to manage itself. the repo johndikeman/dotfiles and branch vps_nix has the config. there's an automatic redeploy action so when you push to this branch, the config will be deployed to the machine.
you can clone other repositories if needed.
Create a feature branch to work on, REMEMBER TO ALWAYS FIRST pull in the most recent 'main' branch and use it as the base of your feature branch in case another user has made changes, to avoid a merge conflict.
when appropriate, write testcases to test new code.
Then, commit the code to the feature branch and open a PR using gh cli.
When the task is complete, mark it as done in the task file (${getPaths().tasksFile}) by changing [ ] to [x]. PREFER USING YOUR EDIT TOOL FOR THIS intead of sed which is prone to failure.
Please add output summarizing the work completed to the files referenced for each particular task.

previous session logs can be found in ~/.pi/agent/sessions/
use lowercase writing and a semi-informal tone.

Context:
- Task File: ${getPaths().tasksFile}
- Current working directory: ${config.workDir}
`;

  let piOutput = "";
  let piError = "";
  let lastAssistantMessage = "";
  let currentStatus = "Starting...";

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
    if (message) message.reply(`Failed to start pi process: ${err.message}`);
    if (isOneShot || !process.env.DISCORD_TOKEN) {
      process.exit(1);
    }
  });

  piProcess.on("close", async (code) => {
    isRunning = false;
    currentRunningTask = null;
    // Check if this was a quota pause
    if (code === 0) {
      log("pi finished successfully.");

      if (message) {
        const finalResponse = lastAssistantMessage || piOutput;
        const cleanedOutput = stripAnsi(finalResponse.trim());
        const truncatedOutput =
          cleanedOutput.length > 1900
            ? "..." + cleanedOutput.slice(-1900)
            : cleanedOutput;
        message.reply(
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

      if (errorMsg.length > 2000) {
        errorMsg = errorMsg.slice(0, 1997) + "...";
      }
      if (message) message.reply(errorMsg);
      log(`pi failed with code ${code}.`);
    }

    if (isOneShot || !process.env.DISCORD_TOKEN) {
      process.exit(code ?? 0);
    }
  });
}

const isOneShot =
  process.argv.includes("--once") ||
  process.argv.includes("--cron") ||
  process.argv.includes("--run");

if (isOneShot) {
  initializeModelSettings();
  log("Starting one-off scheduled agent cycle...");
  runCycle();
} else if (process.env.DISCORD_TOKEN) {
  client.login(process.env.DISCORD_TOKEN);
} else {
  log(
    "No DISCORD_TOKEN provided and --once not specified. Running single cycle...",
  );
  initializeModelSettings();
  runCycle();
}
