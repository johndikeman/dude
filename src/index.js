#!/usr/bin/env node
import "dotenv/config";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import fs from "fs";
import path from "path";
import stripAnsi from "strip-ansi";
import { startTypingLoop } from "./typing.js";
import {
  MAX_EMPTY_RESPONSE_RETRIES,
  nudgePrompt,
  shouldNudge,
} from "./empty-response-retry.js";
import {
  LOOP_BREAK_GRACE,
  LOOP_THRESHOLD,
  createToolLoopDetector,
  loopAbortSummary,
  loopBreakPrompt,
} from "./loop-detect.js";
import { pathToFileURL } from "url";
import { loadPurpose, parsePurposeArgs } from "./purpose.js";
import { buildAgentPrompt } from "./agent-prompt.js";
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
let emptyResponseRetries = 0; // nudges issued for the current run
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
  emptyResponseRetries = 0;
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

  // purpose support: dude-agent --once --purpose <name> [--context "..."]
  // loads a purpose-specific prompt + skills for special-purpose runs
  // (e.g. prediction-markets). the discord/watch path never passes --purpose.
  const { purpose: purposeName, context } = parsePurposeArgs(process.argv);
  let purpose = null;
  if (purposeName) {
    purpose = await loadPurpose(purposeName);
    // skill paths may be bare names resolved against the packaged skills dir
    if (process.env.PI_SKILLS) {
      purpose.skillPaths = purpose.skillPaths.map((p) =>
        p.startsWith("/") ? p : `${process.env.PI_SKILLS.replace(/\/$/, "")}/${p}`,
      );
    }
    log(
      `runCycle: loaded purpose "${purposeName}" (${purpose.skillPaths.length} extra skills)${context ? " with wait-runner context" : ""}`,
    );
  }


  const prompt = buildAgentPrompt({ paths, purpose, context, message });

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
    // purpose-specific skills (dirs) pulled into the session
    ...(purpose && purpose.skillPaths.length
      ? { additionalSkillPaths: purpose.skillPaths }
      : {}),
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

  // -----------------------------------------------------------------
  // tool-loop breaker.
  // glm-5.3-flash has been observed repeating the exact same tool call
  // hundreds of times in a row (session 01a059cf, 2026-08-31: 813x
  // `node test_gd.js 2>&1`, ~1hr wasted). steer a break-the-loop nudge
  // on first detection; abort the session if it keeps looping.
  // -----------------------------------------------------------------
  const loopDetector = createToolLoopDetector();
  let loopSteerIssued = false; // break-the-loop message injected
  let loopAborted = false; // session aborted due to persistent loop
  let loopSignature = null;
  let loopRepeats = 0;

  // https://github.com/earendil-works/pi/blob/74786a748f5314cc2127ebbcfa2d732e9b8433f5/packages/coding-agent/src/core/agent-session.ts#L143
  session.subscribe(async (event) => {
    switch (event.type) {
      case "message_update":
        break;
      case "tool_execution_start": {
        if (loopAborted) break;
        try {
          const { isLoop, repeats, signature } = loopDetector.observe(
            event.toolName,
            event.args,
          );
          if (!isLoop) break;
          loopSignature = signature;
          loopRepeats = repeats;
          if (!loopSteerIssued) {
            loopSteerIssued = true;
            log(
              `tool loop detected: ${signature} x${repeats}; steering break-the-loop nudge`,
            );
            session.steer(loopBreakPrompt(signature, repeats)).catch((e) => {
              log(`loop-break steer failed: ${e?.stack || e?.message || e}`);
            });
          } else if (repeats >= LOOP_THRESHOLD + LOOP_BREAK_GRACE) {
            loopAborted = true;
            // prevent the empty-response nudge from re-prompting the
            // aborted session (it would likely re-enter the same loop)
            emptyResponseRetries = MAX_EMPTY_RESPONSE_RETRIES;
            log(
              `tool loop persists after nudge (${signature} x${repeats}); aborting session`,
            );
            session.abort().catch((e) => {
              log(`loop-breaker abort failed: ${e?.stack || e?.message || e}`);
            });
          }
        } catch (e) {
          log(
            `loop detector error: ${e?.stack || e?.message || e}`,
          );
        }
        break;
      }
      case "agent_settled": {
        lastAssistantMessage = session.getLastAssistantText();
        const err = session.modelRuntime.getError();

        // loop breaker terminated the run; report and bail out before the
        // empty-response nudge logic can re-prompt the dead session.
        if (loopAborted) {
          isRunning = false;
          currentRunningTask = null;
          stopTyping?.();
          log("pi finished: terminated by loop breaker.");
          if (message) {
            const reply = await message.reply(
              `${loopAbortSummary(loopSignature ?? "(unknown)", loopRepeats || LOOP_THRESHOLD)}\nsession file: ${session.sessionFile ?? "<none>"}`,
            );
            if (session.sessionFile) {
              const map = loadDiscordSessionMap();
              map[reply.id] = {
                sessionFile: session.sessionFile,
                timestamp: new Date().toISOString(),
              };
              saveDiscordSessionMap(cleanupOldDiscordSessionEntries(map));
            }
          }
          break;
        }

        // the primary model occasionally returns a completely empty
        // response; pi settles and the run just dies (sometimes mid-task,
        // right after a tool result). nudge the still-open session to
        // continue instead of ending the run.
        if (
          shouldNudge({
            lastAssistantText: lastAssistantMessage,
            error: err,
            attemptsSoFar: emptyResponseRetries,
          })
        ) {
          emptyResponseRetries += 1;
          log(
            `empty model response (settled with no output); nudging session to continue (${emptyResponseRetries}/${MAX_EMPTY_RESPONSE_RETRIES})`,
          );
          session.prompt(nudgePrompt(emptyResponseRetries)).catch((e) => {
            log(`nudge prompt failed: ${e?.stack || e?.message || e}`);
            isRunning = false;
            stopTyping?.();
          });
          break;
        }

        isRunning = false;
        currentRunningTask = null;
        // Check if this was a quota pause
        log("pi finished successfully.");

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
      }
      case "auto_retry_end":
        stopTyping?.();
        isRunning = false;
        emptyResponseRetries = MAX_EMPTY_RESPONSE_RETRIES;
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
