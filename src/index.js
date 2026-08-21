#!/usr/bin/env node
import "dotenv/config";
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
import { execSync, spawn } from "child_process";
import stripAnsi from "strip-ansi";
import * as SCHEDULER from "./scheduler.js";
import * as SESSIONS from "./sessions.js";
import * as AUDIT from "./audit.js";

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
  return {
    configDir,
    tasksFile: path.join(configDir, "tasks.md"),
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

function truncate(str, limit = 2000) {
  if (!str) return "";
  if (str.length <= limit) return str;
  return str.slice(0, limit - 3) + "...";
}

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

async function getGeminiApiKey() {
  if (process.env.GEMINI_JSON_TOKEN) {
    try {
      const auth = JSON.parse(process.env.GEMINI_JSON_TOKEN);
      return JSON.stringify(auth);
    } catch (e) {
      log("GEMINI_JSON_TOKEN is not valid JSON, using as raw token");
      return JSON.stringify({ token: process.env.GEMINI_JSON_TOKEN });
    }
  }
}

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

  const apiKey = await getGeminiApiKey();
  if (!apiKey) {
    const errorMsg = "Could not obtain API key for Gemini.";
    if (interaction) interaction.followUp(errorMsg);
    log(errorMsg);
    isRunning = false;
    currentRunningTask = null;
    return;
  }

  const repoBrief = fs.existsSync(getPaths().repoBriefFile)
    ? fs.readFileSync(getPaths().repoBriefFile, "utf8")
    : "";

  const prompt = `You are a self-improving AI agent. 

${repoBrief ? `### Repository Brief:\n${repoBrief}\n` : ""}

Current Task: ${task}
Current date: ${new Date().toLocaleString("en-US")}
Your goal is to implement this task. your workspace is in (${config.workDir}).
if the task is to improve yourself, this will be in the dude/ directory. if the directory does not exist, you can use the gh cli to clone johndikeman/dude.
you can clone other repositories if needed.
Create a feature branch to work on, REMEMBER TO ALWAYS FIRST pull in the most recent 'main' branch and use it as the base of your feature branch in case another user has made changes, to avoid a merge conflict.
when appropriate, write testcases to test new code.
Then, commit the code to the feature branch and open a PR using gh cli.
When the task is complete, mark it as done in the task file (${getPaths().tasksFile}) by changing [ ] to [x]. PREFER USING YOUR EDIT TOOL FOR THIS intead of sed which is prone to failure.
make sure your final message is a summary of the work that was done, or an explanation of the failure.

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

  // Check if this task has a previous session to resume
  const sessionMapping = SCHEDULER.getSessionMapping(task);
  let existingSessionId = null;
  if (sessionMapping && sessionMapping.sessionId) {
    existingSessionId = sessionMapping.sessionId;
    log(`Resuming task from existing session: ${existingSessionId}`);
    // Clear the session mapping since we're using it now
    SCHEDULER.clearSessionMapping(task);
  }

  // Create a session for this task run
  let previousSessionId = null;

  try {
    const sessionOptions = {
      discordMessageId: statusMessage ? statusMessage.id : null,
      discordChannelId: statusMessage ? statusMessage.channelId : null,
      workspacePath: config.workDir,
      prompt: prompt.substring(0, 2000), // Store prompt snippet
    };

    if (isFallbackRetry) {
      // For fallback retry, find the most recent active session to continue from
      const sessions = SESSIONS.loadSessions();
      const activeSessions = sessions.active.sort(
        (a, b) => b.createdAt - a.createdAt,
      );

      if (activeSessions.length > 0) {
        const prevSession = activeSessions[0];
        previousSessionId = prevSession.id;
        log(`Continuing from previous session: ${previousSessionId}`);

        // Build the prompt to resume with context from previous run
        const continuePrompt = `RESUME MODE: This is a continuation of a previous session that was interrupted due to a quota error. 

Previous error was: ${previousError}

Continuing the task: ${task}

${prompt.substring(prompt.indexOf("You are a self-improving agent"))}`;
        sessionOptions.prompt = continuePrompt.substring(0, 2000);

        sessionOptions.lastModel = MODEL_CODE;
        sessionOptions.lastModelError = previousError;
        sessionOptions.fallbackRetryContext = {
          originalTask,
          previousModelError: previousError,
          fallbackModelUsed: MODEL_CODE,
        };

        // Update the existing session
        SESSIONS.updateSession(previousSessionId, {
          lastModel: MODEL_CODE,
          originalFailureReason: previousError,
          lastRetryAt: Date.now(),
        });
      } else {
        // No previous session found, create new session but track that we should have continued
        sessionOptions.fallbackRetryContext = {
          originalTask,
          previousModelError: previousError,
          fallbackModelUsed: MODEL_CODE,
          noPreviousSession: true,
        };
      }
    }

    // existingSessionId will be here if we already had a session for this prompt in the sessions file
    if (existingSessionId) {
      // Update existing session with new info for this run
      SESSIONS.updateSession(existingSessionId, {
        discordMessageId: statusMessage ? statusMessage.id : null,
        discordChannelId: statusMessage ? statusMessage.channelId : null,
        workspacePath: config.workDir,
      });
      currentSessionId = existingSessionId;
      log(`Resumed session ${currentSessionId} for task: ${task}`);
    } else if (isFallbackRetry && previousSessionId) {
      currentSessionId = previousSessionId;
      log(`Continuing session ${currentSessionId} for fallback retry: ${task}`);
    } else {
      // Create a new session
      const session = SESSIONS.createSession(task, sessionOptions);
      currentSessionId = session.id;
      log(
        `Created session ${currentSessionId} for task: ${task}${isFallbackRetry ? " (fallback retry, no previous session)" : ""}`,
      );
    }
  } catch (e) {
    log(`Failed to manage session: ${e.message}`);
  }

  const sessionFilePath = path.join(
    getPaths().configDir,
    "sessions",
    `${currentSessionId || Date.now()}.jsonl`,
  );

  if (!fs.existsSync(path.dirname(sessionFilePath))) {
    fs.mkdirSync(path.dirname(sessionFilePath), { recursive: true });
  }

  const piArgs = [
    "--provider",
    MODEL_PROVIDER,
    "--model",
    MODEL_CODE,
    "--mode",
    "json",
    "--session",
    sessionFilePath,
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

  // Periodically run the status summarizer
  let statusUpdateInterval = null;
  if (config.statusUpdateInterval > 0) {
    statusUpdateInterval = setInterval(async () => {
      if (!isRunning || !currentSessionId) return;
      try {
        await runStatusSummarizer(
          sessionFilePath,
          (newStatus) => {
            currentStatus = newStatus;
            updateDiscordStatus(true);
          },
          task,
        );
      } catch (e) {
        log(`Error running status summarizer: ${e.message}`);
      }
    }, config.statusUpdateInterval);
  }

  piProcess.on("error", async (err) => {
    if (statusUpdateInterval) clearInterval(statusUpdateInterval);
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

  let stdoutBuffer = "";
  let stderrBuffer = "";

  piProcess.stdout.on("data", (data) => {
    const s = data.toString();
    piOutput += s;
    process.stdout.write(s);

    stdoutBuffer += s;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop(); // Keep the partial line for next chunk

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Try to parse as JSON event (for --mode json)
      try {
        const event = JSON.parse(trimmed);

        // Handle message events (start, update, end)
        if (event.message && event.message.content) {
          // Keep track of the last model message text for the final follow-up
          if (event.message.role === "assistant") {
            let messageText = "";
            for (const content of event.message.content) {
              if (content.type === "text" && content.text) {
                messageText += content.text;
              }
            }
            if (messageText) {
              lastAssistantMessage = messageText;
            }
          }

          for (const content of event.message.content) {
            let text = "";
            if (content.type === "text") text = content.text;
            else if (content.type === "thinking") text = content.thinking;

            if (text) {
              const lines = text.split("\n");
              for (const line of lines) {
                const trimmedLine = line.trim();
                if (trimmedLine.includes("[STATUS]")) {
                  const status = trimmedLine.split("[STATUS]")[1].trim();
                  if (isValidStatus(status)) {
                    currentStatus = status;
                    updateDiscordStatus();
                  }
                }
              }
            }
          }
        }

        // Handle tool execution events
        const toolContent =
          (event.type === "tool_execution_update" &&
            event.partialResult &&
            event.partialResult.content) ||
          (event.type === "tool_execution_end" &&
            event.result &&
            event.result.content);

        if (toolContent) {
          for (const content of toolContent) {
            if (content.type === "text" && content.text) {
              const lines = content.text.split("\n");
              for (const line of lines) {
                const trimmedLine = line.trim();
                if (trimmedLine.includes("[STATUS]")) {
                  const status = trimmedLine.split("[STATUS]")[1].trim();
                  if (isValidStatus(status)) {
                    currentStatus = status;
                    updateDiscordStatus();
                  }
                }
              }
            }
          }
        }

        // Check for quota errors in JSON events
        let quotaErrorInfo = null;
        const errorCandidates = [event.errorMessage, event.error].filter(
          (m) => typeof m === "string",
        );
        for (const candidate of errorCandidates) {
          if (SCHEDULER.isQuotaError(candidate)) {
            quotaErrorInfo = SCHEDULER.parseQuotaError(candidate);
            if (quotaErrorInfo) break;
          }
        }

        if (quotaErrorInfo && !quotaErrorHandled) {
          quotaErrorHandled = true;
          log(`Quota error detected in JSON: ${quotaErrorInfo.errorMessage}`);

          if (USE_FALLBACK_ON_QUOTA_ERROR && FALLBACK_MODEL_CODE) {
            // Use fallback model - restart the session with new model
            log(`Switching to fallback model: ${FALLBACK_MODEL_CODE}`);
            currentStatus = `Quota exhausted. Switching to fallback model ${FALLBACK_MODEL_CODE} to continue...`;
            updateDiscordStatus(true);

            // Kill current pi process
            piProcess.kill("SIGINT");

            // Update the session to use the fallback model (stored in session file)
            // The session file will persist the model info for continuation
            try {
              SESSIONS.updateSession(currentSessionId, {
                lastModel: MODEL_CODE,
                fallbackModelUsed: FALLBACK_MODEL_CODE,
                lastModelError: quotaErrorInfo.errorMessage,
              });
              log(
                `Session updated with fallback info for resume: ${currentSessionId}`,
              );
            } catch (e) {
              log(`Failed to update session with fallback info: ${e.message}`);
            }

            // Stop current cycle and re-queue the task for retry with fallback model
            if (statusUpdateInterval) clearInterval(statusUpdateInterval);
            isRunning = false;
            currentRunningTask = null;
            pausedTaskInfo = null;

            // Add the task back to the queue (will pick up with fallback model on retry)
            addTask(
              `[FALLBACK_RETRY] Original: ${task}\nPrevious error: ${quotaErrorInfo.errorMessage}`,
            );

            // Clear the current model tracking for this cycle
            quotaErrorHandled = true;
            updateDiscordStatus(true);
            return; // exit this handler
          } else {
            // Original behavior - pause the task
            const hasTime =
              quotaErrorInfo.resetAfterMs && quotaErrorInfo.resetAfterMs > 0;
            const waitInfo = hasTime
              ? `until ${formatDuration(quotaErrorInfo.resetAfterMs)}`
              : "until quota resets (estimated 1 hour)";
            currentStatus = `Quota exhausted. Pausing task ${waitInfo}.`;

            // Pause the task
            const paused = SCHEDULER.pauseTask(task, quotaErrorInfo);
            pausedTaskId = paused.id;
            pausedTaskInfo = {
              task,
              resumeAt: paused.resumeAt,
              errorInfo: quotaErrorInfo,
            };

            // Remove the task from pending tasks in tasks.md to prevent retry
            removeTaskFromPending(task);

            // Schedule task as a scheduled task for after quota reset
            SCHEDULER.scheduleTask(task, paused.resumeAt, "quota_resume");
            updateDiscordStatus(true);
          }
        }
      } catch (e) {
        // Not valid JSON, treat as plain text
        // Look for [STATUS] in plain text lines
        if (trimmed.includes("[STATUS]")) {
          const status = trimmed.split("[STATUS]")[1].trim();
          if (isValidStatus(status)) {
            currentStatus = status;
            updateDiscordStatus();
          }
        }

        // Check for quota errors in plain text
        if (SCHEDULER.isQuotaError(trimmed) && !quotaErrorHandled) {
          quotaErrorHandled = true;
          const errorInfo = SCHEDULER.parseQuotaError(trimmed);
          if (errorInfo) {
            log(`Quota error detected in text: ${errorInfo.errorMessage}`);

            if (USE_FALLBACK_ON_QUOTA_ERROR && FALLBACK_MODEL_CODE) {
              // Use fallback model - restart the session with new model
              log(`Switching to fallback model: ${FALLBACK_MODEL_CODE}`);
              currentStatus = `Quota exhausted. Switching to fallback model ${FALLBACK_MODEL_CODE} to continue...`;
              updateDiscordStatus(true);

              // Stop this cycle and re-queue the task for retry
              if (statusUpdateInterval) clearInterval(statusUpdateInterval);
              isRunning = false;
              currentRunningTask = null;
              pausedTaskInfo = null;

              // Add the task back to the queue (will pick up with fallback model on retry)
              addTask(
                `[FALLBACK_RETRY] Original: ${task}\nPrevious error: ${errorInfo.errorMessage}`,
              );

              // Clear the handler
              quotaErrorHandled = true;
              updateDiscordStatus(true);
            } else {
              // Original behavior - pause the task
              currentStatus = `Quota exhausted. Pausing task until ${formatDuration(
                errorInfo.resetAfterMs,
              )}.`;
              updateDiscordStatus(true);

              // Pause the task
              const paused = SCHEDULER.pauseTask(task, errorInfo, {
                sessionId: currentSessionId,
                sessionFile: sessionFilePath,
              });
              pausedTaskId = paused.id;
              pausedTaskInfo = {
                task,
                resumeAt: paused.resumeAt,
                errorInfo,
                sessionId: currentSessionId,
              };

              // Remove the task from pending tasks in tasks.md to prevent retry
              removeTaskFromPending(task);

              // Schedule task as a scheduled task for after quota reset
              SCHEDULER.scheduleTask(task, paused.resumeAt, "quota_resume");
            }
          }
        }
      }
    }
  });

  piProcess.stderr.on("data", (data) => {
    const s = data.toString();
    piError += s;
    process.stderr.write(s);

    stderrBuffer += s;
    const lines = stderrBuffer.split("\n");
    stderrBuffer = lines.pop(); // Keep the partial line for next chunk

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Also check stderr for quota errors
      if (SCHEDULER.isQuotaError(trimmed) && !quotaErrorHandled) {
        quotaErrorHandled = true;
        const errorInfo = SCHEDULER.parseQuotaError(trimmed);
        if (errorInfo) {
          log(`Quota error detected in stderr: ${errorInfo.errorMessage}`);

          if (USE_FALLBACK_ON_QUOTA_ERROR && FALLBACK_MODEL_CODE) {
            // Use fallback model - restart the session with new model
            log(`Switching to fallback model: ${FALLBACK_MODEL_CODE}`);
            currentStatus = `Quota exhausted. Switching to fallback model ${FALLBACK_MODEL_CODE} to continue...`;
            updateDiscordStatus(true);

            // Stop this cycle and re-queue the task for retry
            if (statusUpdateInterval) clearInterval(statusUpdateInterval);
            isRunning = false;
            currentRunningTask = null;
            pausedTaskInfo = null;

            // Add the task back to the queue (will pick up with fallback model on retry)
            addTask(
              `[FALLBACK_RETRY] Original: ${task}\nPrevious error: ${errorInfo.errorMessage}`,
            );

            // Clear the handler
            quotaErrorHandled = true;
            updateDiscordStatus(true);
          } else {
            // Original behavior - pause the task
            const hasTime =
              errorInfo.resetAfterMs && errorInfo.resetAfterMs > 0;
            const waitInfo = hasTime
              ? `until ${formatDuration(errorInfo.resetAfterMs)}`
              : "until quota resets (estimated 1 hour)";
            currentStatus = `Quota exhausted. Pausing task ${waitInfo}.`;
            updateDiscordStatus(true);

            // Pause the task
            const paused = SCHEDULER.pauseTask(task, errorInfo, {
              sessionId: currentSessionId,
              sessionFile: sessionFilePath,
            });
            pausedTaskId = paused.id;
            pausedTaskInfo = {
              task,
              resumeAt: paused.resumeAt,
              errorInfo,
              sessionId: currentSessionId,
            };

            // Remove the task from pending tasks in tasks.md to prevent retry
            removeTaskFromPending(task);

            // Schedule task as a scheduled task for after quota reset
            SCHEDULER.scheduleTask(task, paused.resumeAt, "quota_resume");
          }
        }
      }
    }
  });

  piProcess.on("close", async (code) => {
    if (statusUpdateInterval) clearInterval(statusUpdateInterval);
    isRunning = false;
    currentRunningTask = null;
    // Check if this was a quota pause
    const schedule = SCHEDULER.loadSchedule();
    const isQuotaPause =
      schedule.scheduled.some(
        (t) => t.task === task && t.reason === "quota_resume",
      ) || quotaErrorHandled;

    if (code === 0 && !isQuotaPause) {
      log("pi finished successfully.");
      currentStatus = "Completed successfully.";
      pausedTaskInfo = null; // Clear paused task info for successful completion
      await updateDiscordStatus(true);

      // Complete the session
      try {
        if (currentSessionId) {
          SESSIONS.completeSession(currentSessionId);
          SESSIONS.archiveCompletedSessions();
        }
      } catch (e) {
        log(`Failed to complete session: ${e.message}`);
      }

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

      // If autoNext is enabled, start the next task
      if (config.autoNext) {
        log("autoNext is enabled, starting next task...");
        // Use a short delay to allow file system to settle (especially for tasks.md)
        setTimeout(() => {
          runCycle();
        }, 5000);
      }
    } else if (isQuotaPause) {
      // Task was paused due to quota, already scheduled for resume
      // Keep pausedTaskInfo for status display
      log(`Task ${task} was paused due to quota, scheduled for resume.`);
      const resumeTime =
        schedule.scheduled.find(
          (t) => t.task === task && t.reason === "quota_resume",
        )?.runAt - Date.now() || 0;
      currentStatus = `Paused (quota). Resumes in ${formatDuration(resumeTime)}.`;
      await updateDiscordStatus(true);
      if (interaction) {
        const cleanedOutput = stripAnsi(piOutput.trim());
        const truncatedOutput =
          cleanedOutput.length > 1000
            ? "..." + cleanedOutput.slice(-1000)
            : cleanedOutput;

        let response = `Task ${task} was paused due to Google API quota exhaustion. Will resume automatically when quota resets.`;

        // Include the actual error message that was detected
        const pausedTask = pausedTaskId
          ? schedule.paused.find((t) => t.id === pausedTaskId)
          : null;
        if (pausedTask?.errorInfo?.errorMessage) {
          const errorPreview = pausedTask.errorInfo.errorMessage.slice(0, 300);
          response += `\n\n**Original Error:**\n\`\`\`\n${errorPreview}${errorPreview.length >= 300 ? "..." : ""}\n\`\`\``;
        }

        if (truncatedOutput) {
          response += `\n\n**Output so far:**\n\`\`\`\n${truncatedOutput}\n\`\`\``;
        }

        if (response.length > 2000) {
          response = response.slice(0, 1997) + "...";
        }
        interaction.followUp(response);
      } else if (statusMessage) {
        const cleanedOutput = stripAnsi(piOutput.trim());
        const truncatedOutput =
          cleanedOutput.length > 1000
            ? "..." + cleanedOutput.slice(-1000)
            : cleanedOutput;

        let response = `Task ${task} was paused due to Google API quota exhaustion. Will resume automatically when quota resets.`;

        // Include the actual error message that was detected
        const pausedTask = pausedTaskId
          ? schedule.paused.find((t) => t.id === pausedTaskId)
          : null;
        if (pausedTask?.errorInfo?.errorMessage) {
          const errorPreview = pausedTask.errorInfo.errorMessage.slice(0, 300);
          response += `\n\n**Original Error:**\n\`\`\`\n${errorPreview}${errorPreview.length >= 300 ? "..." : ""}\n\`\`\``;
        }

        if (truncatedOutput) {
          response += `\n\n**Output so far:**\n\`\`\`\n${truncatedOutput}\n\`\`\``;
        }

        if (response.length > 2000) {
          response = response.slice(0, 1997) + "...";
        }
        statusMessage.reply(response);
      }

      // If autoNext is enabled, start the next task (quota-paused task was already removed from pending)
      if (config.autoNext) {
        log("autoNext is enabled, starting next task after quota pause...");
        // When the next task starts, it will set currentRunningTask and clear pausedTaskInfo
        setTimeout(() => {
          runCycle();
        }, 5000);
      }
    } else {
      pausedTaskInfo = null; // Clear paused task info for failures
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

function getPendingTasks() {
  const { tasksFile } = getPaths();
  if (!fs.existsSync(tasksFile)) return [];
  const content = fs.readFileSync(tasksFile, "utf8");

  const tasks = [];
  const lines = content.split(/\r?\n/);
  let currentTask = null;

  for (const line of lines) {
    if (line.startsWith("- [ ] ")) {
      if (currentTask !== null) {
        tasks.push(currentTask.trim());
      }
      currentTask = line.slice(6);
    } else if (line.startsWith("- [x] ") || line.startsWith("#")) {
      if (currentTask !== null) {
        tasks.push(currentTask.trim());
        currentTask = null;
      }
    } else if (currentTask !== null) {
      // If it's an indented line or even if it's not, as long as we're in a task
      // and haven't hit another task marker or header, it's part of the task.
      // We un-indent it if it was indented by two spaces.
      currentTask += "\n" + line.replace(/^  /, "");
    }
  }
  if (currentTask !== null) {
    tasks.push(currentTask.trim());
  }

  return [...new Set(tasks)];
}

client.login(process.env.DISCORD_TOKEN);

async function runStatusSummarizer(sessionFilePath, updateStatus, task) {
  log(`Running status summarizer for session: ${sessionFilePath}`);

  const summarizerPrompt = `Summarize the latest progress of the AI agent working on the following task:
Task: ${task}

Based on the session history, provide a concise one-sentence status update of what the agent is currently doing or has just completed. 
The summary should be suitable for a status display (e.g., "[STATUS] Implementing feature X"). 
Only output the status line starting with [STATUS]. Use lowercase writing and a semi-informal tone.`;

  const piArgs = [
    "--model",
    config.statusUpdateModel || "gemini-2.0-flash",
    "--session",
    sessionFilePath,
    "--print",
    summarizerPrompt,
  ];

  const summarizerProcess = spawn("pi", piArgs, {
    stdio: ["inherit", "pipe", "pipe"],
  });

  let output = "";
  let error = "";
  summarizerProcess.stdout.on("data", (data) => {
    output += data.toString();
  });

  summarizerProcess.stderr.on("data", (data) => {
    error += data.toString();
  });

  summarizerProcess.on("close", (code) => {
    if (code === 0) {
      const lines = output.split("\n");
      for (const line of lines) {
        if (line.trim().includes("[STATUS]")) {
          const status = line.trim().split("[STATUS]")[1].trim();
          // Validate status: should be lowercase and not instructional text
          if (isValidStatus(status)) {
            updateStatus(status);
            break;
          }
        }
      }
    } else {
      log(`Status summarizer failed with code ${code}`);
      if (error) {
        log(`Error output: ${error.trim()}`);
      }
    }
  });
}

// Helper function to validate status messages
// Returns true if the status looks like a legitimate progress update
// (starts with lowercase, not instructional text from prompt)
function isValidStatus(status) {
  if (!status || status.length < 3) return false;

  // Status should start with a letter
  if (!/^[a-zA-Z]/.test(status)) return false;

  // Avoid instructional text from the prompt
  const instructionalPatterns = [
    /^report your status/i,
    /^printing a line/i,
    /^starting with/i,
    /^use lowercase/i,
    /^the summary should/i,
    /^only output/i,
    /^provide a concise/i,
  ];

  for (const pattern of instructionalPatterns) {
    if (pattern.test(status)) return false;
  }

  return true;
}
