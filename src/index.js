#!/usr/bin/env node
import "dotenv/config";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import fs from "fs";
import path from "path";
import stripAnsi from "strip-ansi";
import { startTypingLoop } from "./typing.js";
import { pathToFileURL } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// resolve bundled pi extension entry points (provider extensions etc.) so the
// resource loader picks them up in every session
const ADDITIONAL_EXTENSION_PATHS = ["pi-gemini-batch"]
  .map((pkg) => {
    try {
      return require.resolve(pkg); // absolute path to package main (src/index.js)
    } catch {
      return null;
    }
  })
  .filter(Boolean);

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
  const workingDir = process.env.DUDE_WORKING_DIR;
  const configDir = process.env.DUDE_CONFIG_DIR;
  const piSessionDir = process.env.PI_SESSION_DIR;
  const obsidianDir = process.env.OBSIDIAN_DIR;
  return {
    workingDir,
    configDir,
    piSessionDir,
    tasksFile: path.join(obsidianDir, "ai-tasks.md"),
    logFile: path.join(configDir, "agent.log"),
  };
};

let MODEL_CODE = process.env.DUDE_MODEL || "z-ai/glm-5.3-flash";
let MODEL_PROVIDER = process.env.DUDE_MODEL_PROVIDER || "openrouter";
let FALLBACK_MODEL_CODE = process.env.DUDE_FALLBACK_MODEL || "openrouter/free";
let FALLBACK_MODEL_PROVIDER =
  process.env.DUDE_FALLBACK_MODEL_PROVIDER || "openrouter";
let USE_FALLBACK_ON_QUOTA_ERROR = true;

/** @param {string} msg - the message to log */
function log(msg) {
  const { logFile } = getPaths();
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(logFile, line + "\n");
  } catch (e) {}
}

let isRunning = false;
let currentRunningTask = null;
let pausedTaskInfo = null; // Store info about paused tasks for status display
let lastRunHitQuotaLimit = false;

function getDiscordSessionMapPath() {
  return path.join(getPaths().configDir, "discord-message-sessions.json");
}

function loadDiscordSessionMap() {
  const file = getDiscordSessionMapPath();
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      log(`error loading discord session map: ${e.message}`);
    }
  }
  return {};
}

function saveDiscordSessionMap(map) {
  try {
    fs.writeFileSync(getDiscordSessionMapPath(), JSON.stringify(map, null, 2));
  } catch (e) {
    log(`error saving discord session map: ${e.message}`);
  }
}

function cleanupOldDiscordSessionEntries(map, maxAgeDays = 30) {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const cleaned = {};
  for (const [key, value] of Object.entries(map)) {
    if (value.timestamp && new Date(value.timestamp).getTime() > cutoff) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

client.once("ready", async () => {
  log(`Logged in as ${client.user.tag}!`);
  log(`Current working directory: ${getPaths().workingDir}`);
});

client.on("messageCreate", async (message) => {
  try {
    await handleMessage(message);
  } catch (e) {
    log(`error handling message ${message.id}: ${e?.stack || e?.message || e}`);
  }
});

/** this triggers a one-off run of the agent, separate from the periodic cron job
 * 
 @param {OmitPartialGroupDMChannel<Message<boolean>>} message - the discord message that triggered the agent run */
async function handleMessage(message) {
  // Ignore bot messages
  if (message.author.bot) return;

  log(
    `discord message from ${message.author.tag} (${message.channelId}, dm=${!message.guild})`,
  );

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

  let sessionFileToResume = null;
  if (repliedToBot && referencedMessage) {
    const map = loadDiscordSessionMap();
    const entry = map[referencedMessage.id];
    if (entry?.sessionFile && fs.existsSync(entry.sessionFile)) {
      sessionFileToResume = entry.sessionFile;
      log(
        `found session to resume for message ${referencedMessage.id}: ${sessionFileToResume}`,
      );
    } else if (entry?.sessionFile) {
      log(`session file no longer exists for message ${referencedMessage.id}`);
    }
  }

  runCycle(message, sessionFileToResume).catch((e) =>
    log(`runCycle: failed: ${e?.stack || e?.message || e}`),
  );
}

/** this triggers a one-off run of the agent, separate from the periodic cron job
 * @import {OmitPartialGroupDMChannel, Message} from 'discord.js'
 @param {OmitPartialGroupDMChannel<Message<boolean>>} message - the discord message that triggered the agent run */
async function runCycle(message = null, sessionFileToResume = null) {
  isRunning = true;
  lastRunHitQuotaLimit = false;
  log(
    `runCycle: starting (${message ? "discord-triggered" : "scheduled"})${sessionFileToResume ? " [resumed]" : ""}`,
  );

  // keep a "typing..." indicator visible in the channel for the whole run
  const stopTyping = message ? startTypingLoop(message.channel, { log }) : null;

  // Resolve all paths once and validate the critical ones up front so a
  // missing env var surfaces a clear error instead of an opaque
  // "Cannot read properties of undefined (reading 'startsWith')" deeper
  // inside the pi runtime.
  const paths = getPaths();
  const cwd = paths.workingDir;
  if (!cwd) {
    throw new Error(
      "DUDE_WORKING_DIR is not set; cannot create agent session without a working directory",
    );
  }
  if (!paths.configDir) {
    throw new Error(
      "DUDE_CONFIG_DIR is not set; cannot create agent session without a config directory",
    );
  }
  if (!paths.piSessionDir) {
    throw new Error(
      "PI_SESSION_DIR is not set; cannot create agent session without a session directory",
    );
  }
  log(`runCycle: working directory = ${cwd}`);

  const prompt = `You are a self-improving AI agent named "dude". your source code is contained in the github repository johndikeman/dude
Current date: ${new Date().toLocaleString("en-US")}
Your goal is to implement the tasks/goals laid out for you in ${paths.tasksFile}. 
your workspace is in (${paths.workingDir}).
you have access to the gh cli, an obsidian vault, a onepassword service account for credentials, and the vps you're running in.
the vps is an ubuntu server which uses nix + home-manager to manage itself. the repo johndikeman/dotfiles and branch vps_nix has the config. there's an automatic redeploy action so when you push to this branch, the config will be deployed to the machine.
you can clone other repositories if needed.
Create a feature branch to work on, REMEMBER TO ALWAYS FIRST pull in the most recent 'main' branch and use it as the base of your feature branch in case another user has made changes, to avoid a merge conflict.
when appropriate, write testcases to test new code.
Then, commit the code to the feature branch and open a PR using gh cli.
the task files have obsidian links to other files, which contain the full instructions for the task. if feedback is required, leave a note to myself and your future self runs in this file and quit. also log the actions you take and general design in this file as well.
When the task is complete, mark it as done in the task file (${paths.tasksFile}) by changing [ ] to [x]. PREFER USING YOUR EDIT TOOL FOR THIS intead of sed which is prone to failure.

previous session logs can be found in ${paths.piSessionDir} 
use lowercase writing and a semi-informal tone.

Context:
- Task File: ${paths.tasksFile}
- Current working directory: ${paths.workingDir}
${message ? "\n you're being invoked as a one-off through discord, user message is:\n" + message.content : ""}
`;

  let lastAssistantMessage = "";

  log("runCycle: creating model runtime...");
  const runtime = await ModelRuntime.create({
    allowModelNetwork: true,
    modelRefreshTimeoutMs: 15_000,
  });

  log("runCycle: model runtime created");

  // Use the configured primary model; if the previous run exhausted a
  // quota/credit limit and a fallback is configured, switch to it.
  let modelProvider = MODEL_PROVIDER;
  let modelCode = MODEL_CODE;
  if (
    lastRunHitQuotaLimit &&
    USE_FALLBACK_ON_QUOTA_ERROR &&
    FALLBACK_MODEL_CODE
  ) {
    log(
      `runCycle: primary model ${MODEL_PROVIDER}/${MODEL_CODE} hit quota limit last run, using fallback ${FALLBACK_MODEL_PROVIDER}/${FALLBACK_MODEL_CODE}`,
    );
    modelProvider = FALLBACK_MODEL_PROVIDER;
    modelCode = FALLBACK_MODEL_CODE;
  }
  log(`runCycle: requesting model ${modelProvider}/${modelCode}`);
  const model = runtime.getModel(modelProvider, modelCode);
  if (!model) {
    throw new Error(
      `Model ${modelProvider}/${modelCode} is not configured in pi's model catalog`,
    );
  }
  log(`runCycle: model resolved: ${model.id} (${model.provider})`);

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: paths.configDir,
    appendSystemPromptOverride: (base) => [...base, prompt],
    // load npm-packaged pi extensions (gemini batch provider, etc.)
    additionalExtensionPaths: ADDITIONAL_EXTENSION_PATHS,
  });

  // Use default tools for custom cwd
  log("runCycle: creating agent session...");
  let sessionManager;
  if (sessionFileToResume) {
    sessionManager = SessionManager.open(
      sessionFileToResume,
      paths.piSessionDir,
    );
    log(`runCycle: opened existing session ${sessionFileToResume}`);
  } else {
    sessionManager = SessionManager.create(cwd, paths.piSessionDir);
    log(`runCycle: created new session in ${paths.piSessionDir}`);
  }
  const { session } = await createAgentSession({
    cwd,
    resourceLoader,
    sessionManager,
    model,
    thinkingLevel: "low",
  });
  log(
    `runCycle: agent session created (sessionFile=${session.sessionFile ?? "<none>"})`,
  );

  // https://github.com/earendil-works/pi/blob/74786a748f5314cc2127ebbcfa2d732e9b8433f5/packages/coding-agent/src/core/agent-session.ts#L143
  session.subscribe(async (event) => {
    switch (event.type) {
      case "message_update":
        break;
      case "agent_settled":
        isRunning = false;
        currentRunningTask = null;
        // Check if this was a quota pause
        log("pi finished successfully.");
        lastAssistantMessage = session.getLastAssistantText();
        const err = session.modelRuntime.getError();

        stopTyping?.();
        if (message) {
          if (lastRunHitQuotaLimit) {
            // auto_retry_end already replied with the failure details.
            log("run ended due to quota limit; failure already surfaced");
          } else if (!lastAssistantMessage && !err) {
            const reply = await message.reply(
              "pi exited without output or error?",
            );
            if (session.sessionFile) {
              const map = loadDiscordSessionMap();
              map[reply.id] = {
                sessionFile: session.sessionFile,
                timestamp: new Date().toISOString(),
              };
              saveDiscordSessionMap(cleanupOldDiscordSessionEntries(map));
            }
          } else {
            const finalResponse =
              (lastAssistantMessage ? lastAssistantMessage : "") +
              "\n" +
              (err ? err : "");
            const cleanedOutput = stripAnsi(finalResponse.trim());
            const truncatedOutput =
              cleanedOutput.length > 1900
                ? "..." + cleanedOutput.slice(-1900)
                : cleanedOutput;
            const reply = await message.reply(
              truncatedOutput ||
                "pi exited with either some output or some error but we failed to surface it.",
            );
            if (session.sessionFile) {
              const map = loadDiscordSessionMap();
              map[reply.id] = {
                sessionFile: session.sessionFile,
                timestamp: new Date().toISOString(),
              };
              saveDiscordSessionMap(cleanupOldDiscordSessionEntries(map));
              log(
                `saved session mapping: reply ${reply.id} -> ${session.sessionFile}`,
              );
            }
          }
        }
        break;
      case "auto_retry_end":
        stopTyping?.();
        isRunning = false;
        currentRunningTask = null;
        pausedTaskInfo = null;
        log(`pi failed: ${event.finalError}`);
        if (/402|credit|quota|insufficient/i.test(String(event.finalError))) {
          lastRunHitQuotaLimit = true;
          log("quota/credit limit detected.");
        }
        if (message) {
          const reply = await message.reply(
            `pi has failed: ${truncateLine(event.finalError, 1999).text}`,
          );
          if (session.sessionFile) {
            const map = loadDiscordSessionMap();
            map[reply.id] = {
              sessionFile: session.sessionFile,
              timestamp: new Date().toISOString(),
            };
            saveDiscordSessionMap(cleanupOldDiscordSessionEntries(map));
            log(
              `saved session mapping: reply ${reply.id} -> ${session.sessionFile}`,
            );
          }
        }
        break;
    }
  });

  // Actually kick off the agent run - without this the session sits idle.
  const promptToSend =
    sessionFileToResume && message
      ? `current date: ${new Date().toLocaleString("en-US")}\n\nuser sent a follow-up via discord:\n${message.content}`
      : prompt;
  log("runCycle: sending prompt to agent...");
  session.prompt(promptToSend).catch(async (e) => {
    stopTyping?.();
    isRunning = false;
    log(`runCycle: prompt failed: ${e?.stack || e?.message || e}`);
    if (message) {
      const reply = await message.reply(
        `agent failed to start: ${e?.message || e}`,
      );
      if (session.sessionFile) {
        const map = loadDiscordSessionMap();
        map[reply.id] = {
          sessionFile: session.sessionFile,
          timestamp: new Date().toISOString(),
        };
        saveDiscordSessionMap(cleanupOldDiscordSessionEntries(map));
        log(
          `saved session mapping: reply ${reply.id} -> ${session.sessionFile}`,
        );
      }
    }
  });
}

const isOneShot =
  process.argv.includes("--once") ||
  process.argv.includes("--cron") ||
  process.argv.includes("--run");

if (isOneShot) {
  log("Starting one-off scheduled agent cycle...");
  runCycle();
} else if (process.env.DISCORD_TOKEN) {
  client.login(process.env.DISCORD_TOKEN);
} else {
  log(
    "No DISCORD_TOKEN provided and --once not specified. Running single cycle...",
  );
  runCycle();
}
