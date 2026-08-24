#!/usr/bin/env node
import "dotenv/config";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import fs from "fs";
import path from "path";
import stripAnsi from "strip-ansi";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  truncateLine,
} from "@earendil-works/pi-coding-agent";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message],
});

const getPaths = () => {
  const configDir = process.env.DUDE_CONFIG_DIR;
  const piSessionDir = process.env.PI_SESSION_DIR;
  const obsidianDir = process.env.OBSIDIAN_DIR;
  return {
    configDir,
    piSessionDir,
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
  try {
    await handleMessage(message);
  } catch (e) {
    log(`error handling message ${message.id}: ${e?.message || e}`);
  }
});

async function handleMessage(message) {
  // Ignore bot messages
  if (message.author.bot) return;

  log(
    `discord message from ${message.author.tag} (${message.channelId}, dm=${!message.guild})`,
  );

  // Store channel ID for autoNext status updates
  if (message.channelId && config.lastChannelId !== message.channelId) {
    config.lastChannelId = message.channelId;
    saveConfig();
  }

  // Check if this is a reply to a bot message
  // Fetch the referenced message with a hard timeout - this REST call can
  // hang (rate limits, lost REST connection) and would deadlock the handler.
  const referencedMessage = message.reference
    ? await Promise.race([
        message.fetchReference(),
        new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
      ]).catch(() => null)
    : null;

  // or if user directly tagged the bot (works in DMs too)
  const taggedBotDirectly = message.mentions.has(client.user.id);

  const repliedToBot = referencedMessage?.author?.bot === true;
  const isDM = !message.guild;

  // Trigger on a reply to one of the bot's messages, a direct tag,
  // or any non-bot DM.
  if (!repliedToBot && !taggedBotDirectly && !isDM) {
    log(
      `ignoring message ${message.id}: repliedToBot=${repliedToBot} taggedBot=${taggedBotDirectly}`,
    );
    return;
  }
  runCycle(message).catch((e) =>
    log(`runCycle: failed: ${e?.message || e}`),
  );
}

/** this triggers a one-off run of the agent, separate from the periodic cron job
 * @import {OmitPartialGroupDMChannel, Message} from 'discord.js'
 @param {OmitPartialGroupDMChannel<Message<boolean>>} message - the discord message that triggered the agent run */
async function runCycle(message = null) {
  isRunning = true;
  log(`runCycle: starting (${message ? "discord-triggered" : "scheduled"})`);

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
the task files have obsidian links to other files, which contain the full instructions for the task. if feedback is required, leave a note to myself and your future self runs in this file and quit. also log the actions you take and general design in this file as well.
When the task is complete, mark it as done in the task file (${getPaths().tasksFile}) by changing [ ] to [x]. PREFER USING YOUR EDIT TOOL FOR THIS intead of sed which is prone to failure.

previous session logs can be found in ${getPaths().piSessionDir} 
use lowercase writing and a semi-informal tone.

Context:
- Task File: ${getPaths().tasksFile}
- Current working directory: ${config.workDir}
${message ? "\n you're being invoked as a one-off through discord, user message is:\n" + message.content : ""}
`;

  let lastAssistantMessage = "";

  const cwd = config.workDir;
  log("runCycle: creating model runtime...");
  const runtime = await ModelRuntime.create();
  log("runCycle: model runtime created");

  const openrouter_gemini = runtime.getModel("openrouter", "stealth/ox-alpha");

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getPaths().configDir,
    appendSystemPromptOverride: (base) => [...base, prompt],
  });

  // Use default tools for custom cwd
  log("runCycle: creating agent session...");
  const { session } = await createAgentSession({
    cwd,
    resourceLoader,
    sessionManager: SessionManager.create(cwd, getPaths().piSessionDir),
    model: openrouter_gemini,
    thinkingLevel: "low",
  });
  log("runCycle: agent session created");

  // https://github.com/earendil-works/pi/blob/74786a748f5314cc2127ebbcfa2d732e9b8433f5/packages/coding-agent/src/core/agent-session.ts#L143
  session.subscribe((event) => {
    switch (event.type) {
      case "message_update":
        break;
      case "agent_settled":
        isRunning = false;
        currentRunningTask = null;
        // Check if this was a quota pause
        log("pi finished successfully.");
        lastAssistantMessage = session.getLastAssistantText();

        if (message) {
          const finalResponse = lastAssistantMessage;
          const cleanedOutput = stripAnsi(finalResponse.trim());
          const truncatedOutput =
            cleanedOutput.length > 1900
              ? "..." + cleanedOutput.slice(-1900)
              : cleanedOutput;
          message.reply(
            truncatedOutput || "Task completed successfully (no output).",
          );
        }
        break;
      case "auto_retry_end":
        isRunning = false;
        currentRunningTask = null;
        pausedTaskInfo = null;
        log(`pi failed: ${event.finalError}`);
        if (message)
          message.reply(
            `pi has failed: ${truncateLine(event.finalError, 1999).text}`,
          );
        break;
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
