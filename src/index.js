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
import https from "https";
import fs from "fs";
import path from "path";
import { execSync, spawn } from "child_process";
import stripAnsi from "strip-ansi";
import * as SCHEDULER from "./scheduler.js";
import * as SESSIONS from "./sessions.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message],
});

const CONFIG_DIR = process.env.DUDE_CONFIG_DIR || process.cwd();

const TASKS_FILE = path.join(CONFIG_DIR, "tasks.md");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const LOG_FILE = path.join(CONFIG_DIR, "agent.log");
const REPO_BRIEF_FILE = path.join(process.cwd(), "REPO_BRIEF.md");

let MODEL_CODE = "gemini-3-flash-preview";
let MODEL_PROVIDER = "google-gemini-cli";

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (e) {}
}

let config = {
  workDir: process.cwd(),
  autoNext: false,
};

let isRunning = false;

if (fs.existsSync(CONFIG_FILE)) {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// Slash Command Definitions
const commands = [
  new SlashCommandBuilder()
    .setName("task")
    .setDescription("Add a new task to the queue")
    .addStringOption((option) =>
      option
        .setName("description")
        .setDescription("The task description")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("tasks")
    .setDescription("List all pending tasks"),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show current working directory and queue status"),
  new SlashCommandBuilder()
    .setName("workdir")
    .setDescription("Change the working directory")
    .addStringOption((option) =>
      option
        .setName("path")
        .setDescription("Absolute path to the new working directory")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("clone")
    .setDescription(
      "Clone a repository into the current or a new working directory",
    )
    .addStringOption((option) =>
      option
        .setName("repo")
        .setDescription("GitHub repository (e.g., owner/repo)")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("path")
        .setDescription(
          "Path to clone into (optional, defaults to a subdirectory in current workDir)",
        ),
    ),
  new SlashCommandBuilder()
    .setName("start")
    .setDescription("Start working on the next task"),
  new SlashCommandBuilder()
    .setName("restart")
    .setDescription("Restart the agent process (via systemd)"),
  new SlashCommandBuilder()
    .setName("schedule")
    .setDescription("Schedule a task to run at a specific time")
    .addStringOption((option) =>
      option
        .setName("task")
        .setDescription("The task to schedule")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("time")
        .setDescription(
          "When to run (e.g., 5m, 1h, 2h30m, or an absolute time like '14:30')",
        )
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("paused")
    .setDescription("List paused tasks due to quota errors"),
  new SlashCommandBuilder()
    .setName("scheduled")
    .setDescription("List scheduled tasks"),
  new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Resume a paused task immediately")
    .addStringOption((option) =>
      option
        .setName("id")
        .setDescription("The ID of the paused task")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("cancel")
    .setDescription("Cancel a paused or scheduled task")
    .addStringOption((option) =>
      option
        .setName("id")
        .setDescription("The ID of the task to cancel")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("type")
        .setDescription("Type of task to cancel (paused or scheduled)")
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("autonext")
    .setDescription("Toggle automatic processing of the next task in the queue")
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("Set auto-next mode")
        .setRequired(true)
        .addChoices({ name: "on", value: "on" }, { name: "off", value: "off" }),
    ),
  new SlashCommandBuilder().setName("help").setDescription("Show help message"),
  new SlashCommandBuilder()
    .setName("modelcode")
    .setDescription("change the gemini model code")
    .addStringOption((option) =>
      option
        .setName("code")
        .setDescription("the model code")
        .setRequired(true)
        .addChoices(
          { name: "gemini-3-flash-preview", value: "gemini-3-flash-preview" },
          { name: "gemini-3-pro-preview", value: "gemini-3-pro-preview" },
          { name: "qwen3.5:122b", value: "qwen3.5:122b" },
          { name: "gemini-2.5-pro", value: "gemini-2.5-pro" },
        ),
    ),
  new SlashCommandBuilder()
    .setName("sessions")
    .setDescription("List active sessions that can be resumed via reply"),
  new SlashCommandBuilder()
    .setName("linkpr")
    .setDescription(
      "Link the current session to a GitHub PR for resume via comment",
    )
    .addStringOption((option) =>
      option
        .setName("number")
        .setDescription("The PR number")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("repo")
        .setDescription(
          "The repository (owner/name, defaults to GITHUB_REPO env var)",
        ),
    ),
];

client.once("ready", async () => {
  log(`Logged in as ${client.user.tag}!`);
  log(`Current working directory: ${config.workDir}`);

  // Register slash commands
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  try {
    log("Started refreshing application (/) commands.");
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands,
    });
    log("Successfully reloaded application (/) commands.");
  } catch (error) {
    log(`Error reloading commands: ${error}`);
  }

  // Check for ready scheduled tasks periodically (every 5 minutes)
  setInterval(checkAndRunScheduledTasks, 5 * 60 * 1000);

  // Check GitHub PR comments for resume requests (every 5 minutes)
  if (process.env.GITHUB_TOKEN) {
    setInterval(checkGitHubPRComments, 5 * 60 * 1000);
    log("GitHub PR comment checking enabled");
  }

  // Archive old sessions periodically (every hour)
  setInterval(
    () => {
      try {
        SESSIONS.archiveCompletedSessions();
      } catch (e) {
        log(`Failed to archive sessions: ${e.message}`);
      }
    },
    60 * 60 * 1000,
  );

  // Initial check for scheduled tasks on startup
  await checkAndRunScheduledTasks();

  // If autoNext is enabled, start working on startup
  if (config.autoNext && !isRunning) {
    const tasks = getPendingTasks();
    if (tasks.length > 0) {
      log("autoNext is enabled, starting cycle on startup...");
      runCycle();
    }
  }
});

// Check and run scheduled tasks
async function checkAndRunScheduledTasks() {
  const ready = SCHEDULER.getReadyTasks();

  if (ready.paused.length > 0) {
    log(`Found ${ready.paused.length} paused tasks ready to resume`);
    for (const task of ready.paused) {
      log(`Resuming paused task: ${task.task}`);
      // Remove from paused and add back to tasks.md
      ready.schedule.paused = ready.schedule.paused.filter(
        (t) => t.id !== task.id,
      );
      SCHEDULER.saveSchedule(ready.schedule);
      // Add task back to queue
      addTask(task.task);
    }
  }

  if (ready.scheduled.length > 0) {
    log(`Found ${ready.scheduled.length} scheduled tasks ready to run`);
    const { schedule } = ready;
    for (const task of ready.scheduled) {
      log(`Running scheduled task: ${task.task}`);
      // Remove from scheduled
      schedule.scheduled = schedule.scheduled.filter((t) => t.id !== task.id);
      SCHEDULER.saveSchedule(schedule);
      // Add task back to queue to be picked up
      addTask(task.task);
    }
  }

  // If autoNext is enabled, start working if not already running
  if (
    config.autoNext &&
    !isRunning &&
    (ready.paused.length > 0 || ready.scheduled.length > 0)
  ) {
    log("autoNext is enabled, starting cycle after resume/schedule...");
    runCycle();
  }
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, options } = interaction;

  if (commandName === "task") {
    const task = options.getString("description");
    addTask(task);
    await interaction.reply(`Task added: ${task}`);

    // If autoNext is enabled, start working if not already running
    if (config.autoNext && !isRunning) {
      log("autoNext is enabled, starting cycle after task addition...");
      runCycle();
    }
  }

  if (commandName === "tasks") {
    const tasks = getPendingTasks();
    if (tasks.length === 0) {
      await interaction.reply("No pending tasks.");
    } else {
      let list = tasks.map((t, i) => `${i + 1}. ${t}`).join("\n");
      let response = `**Pending Tasks:**\n${list}`;

      if (response.length > 2000) {
        response = response.slice(0, 1990) + "... (truncated)";
      }

      await interaction.reply(response);
    }
  }

  if (commandName === "status") {
    const tasks = getPendingTasks();
    const status = [
      `**Status Report**`,
      `Working Directory: \`${config.workDir}\``,
      `Model: ${MODEL_CODE}`,
      `Auto-Next: ${config.autoNext ? "**ON**" : "OFF"}`,
      `Pending Tasks: ${tasks.length}`,
      tasks.length > 0 ? `Next Task: ${tasks[0]}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    await interaction.reply(status);
  }

  if (commandName === "workdir") {
    const newDir = options.getString("path");
    if (fs.existsSync(newDir)) {
      config.workDir = path.resolve(newDir);
      saveConfig();
      await interaction.reply(
        `Working directory updated to: ${config.workDir}`,
      );
    } else {
      await interaction.reply(`Directory does not exist: ${newDir}`);
    }
  }

  if (commandName === "modelcode") {
    const newCode = options.getString("code");
    if (newCode === "qwen3.5:122b") {
      MODEL_PROVIDER = "verda";
    } else {
      MODEL_PROVIDER = "google-gemini-cli";
    }
    MODEL_CODE = newCode;
    await interaction.reply(`model updated to ${MODEL_CODE}`);
  }

  if (commandName === "autonext") {
    const mode = options.getString("mode");
    config.autoNext = mode === "on";
    saveConfig();
    await interaction.reply(
      `Automatic processing of next task is now **${config.autoNext ? "ON" : "OFF"}**`,
    );
  }

  if (commandName === "clone") {
    const repo = options.getString("repo");
    const customPath = options.getString("path");
    const clonePath = customPath
      ? path.resolve(customPath)
      : path.join(config.workDir, repo.split("/").pop());

    await interaction.deferReply();
    try {
      if (fs.existsSync(clonePath)) {
        await interaction.editReply(`Path already exists: ${clonePath}`);
        return;
      }
      log(`Cloning ${repo} into ${clonePath}...`);
      execSync(`gh repo clone ${repo} ${clonePath}`);
      config.workDir = clonePath;
      saveConfig();
      await interaction.editReply(
        `Cloned \`${repo}\` to \`${clonePath}\` and updated working directory.`,
      );
    } catch (err) {
      log(`Error cloning: ${err.message}`);
      await interaction.editReply(
        `Failed to clone \`${repo}\`: ${err.message}`,
      );
    }
  }

  if (commandName === "start") {
    await interaction.reply("Starting self-improvement cycle...");
    runCycle(interaction);
  }

  if (commandName === "restart") {
    await interaction.reply("Restarting agent...");
    process.exit(0);
  }

  if (commandName === "schedule") {
    const task = options.getString("task");
    const timeStr = options.getString("time");
    await interaction.deferReply();
    try {
      const runAt = parseScheduleTime(timeStr);
      if (!runAt) {
        await interaction.editReply(
          `Invalid time format: ${timeStr}. Use formats like '5m', '1h', '2h30m', or '14:30'`,
        );
        return;
      }
      const scheduled = SCHEDULER.scheduleTask(task, runAt, "manual");
      await interaction.editReply(
        `Task scheduled!\n**Task:** ${task}\n**Run at:** ${new Date(
          runAt,
        ).toLocaleString()}`,
      );
    } catch (err) {
      log(`Error scheduling task: ${err.message}`);
      await interaction.editReply(`Failed to schedule task: ${err.message}`);
    }
  }

  if (commandName === "paused") {
    const paused = SCHEDULER.listPausedTasks();
    if (paused.length === 0) {
      await interaction.reply("No paused tasks.");
    } else {
      const list = paused
        .map(
          (t) =>
            `**ID:** ${t.id}\n**Task:** ${t.task}\n**Resumes at:** ${new Date(
              t.resumeAt,
            ).toLocaleString()}\n**Time remaining:** ${formatDuration(
              t.timeRemaining,
            )}`,
        )
        .join("\n\n---\n");
      await interaction.reply(`**Paused Tasks:**\n${list}`);
    }
  }

  if (commandName === "scheduled") {
    const scheduled = SCHEDULER.listScheduledTasks();
    if (scheduled.length === 0) {
      await interaction.reply("No scheduled tasks.");
    } else {
      const list = scheduled
        .map(
          (t) =>
            `**ID:** ${t.id}\n**Task:** ${t.task}\n**Runs at:** ${new Date(
              t.runAt,
            ).toLocaleString()}\n**Reason:** ${t.reason}`,
        )
        .join("\n\n---\n");
      await interaction.reply(`**Scheduled Tasks:**\n${list}`);
    }
  }

  if (commandName === "resume") {
    const taskId = options.getString("id");
    await interaction.deferReply();
    try {
      const removed = SCHEDULER.cancelPausedTask(taskId);
      if (!removed) {
        await interaction.editReply(`No paused task found with ID: ${taskId}`);
        return;
      }
      // Add the task back to tasks.md
      addTask(removed.task);
      await interaction.editReply(
        `Task resumed and added back to queue!\n**Task:** ${removed.task}`,
      );
    } catch (err) {
      log(`Error resuming task: ${err.message}`);
      await interaction.editReply(`Failed to resume task: ${err.message}`);
    }
  }

  if (commandName === "cancel") {
    const taskId = options.getString("id");
    const type = options.getString("type");
    await interaction.deferReply();
    try {
      let removed = null;
      if (type === "scheduled" || !type) {
        removed = SCHEDULER.cancelScheduledTask(taskId);
      }
      if (!removed && (type !== "scheduled" || !type)) {
        removed = SCHEDULER.cancelPausedTask(taskId);
      }
      if (!removed) {
        await interaction.editReply(`No task found with ID: ${taskId}`);
        return;
      }
      await interaction.editReply(`Task cancelled!\n**Task:** ${removed.task}`);
    } catch (err) {
      log(`Error cancelling task: ${err.message}`);
      await interaction.editReply(`Failed to cancel task: ${err.message}`);
    }
  }

  if (commandName === "sessions") {
    const activeSessions = SESSIONS.getActiveSessions();
    if (activeSessions.length === 0) {
      await interaction.reply(
        "No active sessions. Run a task with `/start` to create one.",
      );
    } else {
      const list = activeSessions
        .map(
          (s) =>
            `[ID: ${s.id}] ${s.task.substring(0, 50)}${s.task.length > 50 ? "..." : ""}\n  Created: ${s.createdAt}${s.discordMessageId ? "\n  Reply to my Discord message to resume" : ""}${s.prNumber ? `\n  Linked to PR #${s.prNumber} (comment /resume to resume)` : ""}`,
        )
        .join("\n\n");
      let response = `**Active Sessions:**\n\n${list}`;
      if (response.length > 2000) {
        response = response.slice(0, 1990) + "... (truncated)";
      }
      await interaction.reply(response);
    }
  }

  if (commandName === "linkpr") {
    const prNumber = options.getString("number");
    const repo = options.getString("repo") || process.env.GITHUB_REPO || "";

    await interaction.deferReply();
    try {
      const session = SESSIONS.getActiveSessions()[0];
      if (!session) {
        await interaction.editReply(
          "No active session to link. Start a task with `/start` first.",
        );
        return;
      }

      SESSIONS.linkPR(session.id, parseInt(prNumber), repo);
      await interaction.editReply(
        `Linked PR #${prNumber} in ${repo} to session ${session.id}. Comments on this PR will be checked for resume requests.`,
      );
    } catch (err) {
      log(`Error linking PR: ${err.message}`);
      await interaction.editReply(`Failed to link PR: ${err.message}`);
    }
  }

  if (commandName === "help") {
    await interaction.reply(
      [
        `**Commands:**`,
        `/task <desc> - Add a task`,
        `/tasks - List tasks`,
        `/status - Show status`,
        `/workdir <path> - Change working directory`,
        `/start - Start working on the next task`,
        `/schedule <task> <time> - Schedule a task`,
        `/paused - List paused tasks`,
        `/scheduled - List scheduled tasks`,
        `/resume <id> - Resume a paused task`,
        `/cancel <id> [type] - Cancel a task`,
        `/sessions - List active sessions`,
        `/restart - Restart the agent`,
        `/help - Show this message`,
      ].join("\n"),
    );
  }
});

// Handle Discord message replies for session resumption
client.on("messageCreate", async (message) => {
  // Ignore bot messages
  if (message.author.bot) return;

  // Check if this is a reply to a bot message
  const referencedMessage = message.reference
    ? await message.fetchReference().catch(() => null)
    : null;

  if (!referencedMessage || !referencedMessage.author?.bot) return;

  // Check if this message references a session
  const session = SESSIONS.getSessionByDiscordMessage(referencedMessage.id);
  if (!session) return;

  // User replied to a session - create a new task with feedback
  log(`Received feedback on session ${session.id}: ${message.content}`);

  const feedbackTask = `Resume session ${session.id} with the following feedback:\n\n${message.content}\n\nPrevious task context:\n${session.task}`;

  addTask(feedbackTask);

  await message.reply(
    `Thanks for the feedback! I've added a new task to resume the session:\n\`${session.task}\`\n\nYour feedback:\n>${message.content}`,
  );

  // Suspend the current session
  SCHEDULER.suspendSession(session.id, "awaiting resumption with feedback");
});

// GitHub PR Webhook handler (polling-based for PR comments)
let lastGitHubCheck = 0;
const GITHUB_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

async function checkGitHubPRComments() {
  const now = Date.now();
  if (now - lastGitHubCheck < GITHUB_CHECK_INTERVAL) return;
  lastGitHubCheck = now;

  const sessions = SESSIONS.getActiveSessions();
  for (const session of sessions) {
    if (!session.prNumber || !session.prRepo) continue;

    // Check PR comments for resumption requests
    const prComments = await fetchPRComments(
      session.prRepo,
      session.prNumber,
    ).catch(() => []);

    // Look for comments with specific patterns like "/resume" or "continue"
    const resumeComment = prComments.find((c) =>
      /\/resume|continue this|resum[e] session/i.test(c.body),
    );

    if (resumeComment) {
      log(
        `Found resumption request on PR #${session.prNumber}: ${resumeComment.body}`,
      );

      const feedbackTask = `Resume session ${session.id} with PR #${
        session.prNumber
      } review feedback:\n\n${resumeComment.body}`;

      addTask(feedbackTask);
      SESSIONS.completeSession(session.id);
    }
  }
}

// Fetch PR comments from GitHub API
async function fetchPRComments(repo, prNumber) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return [];

  const [owner, name] = repo.split("/");
  if (!owner || !name) return [];

  return new Promise((resolve, reject) => {
    const url = `https://api.github.com/repos/${owner}/${name}/issues/${prNumber}/comments`;

    const options = {
      hostname: "api.github.com",
      path: url,
      method: "GET",
      headers: {
        Authorization: `token ${token}`,
        "User-Agent": "dude-agent",
        Accept: "application/vnd.github.v3+json",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data) || []);
          } catch (e) {
            resolve([]);
          }
        } else {
          resolve([]);
        }
      });
    });

    req.on("error", (e) => reject(e));
    req.setTimeout(10000, () => {
      req.destroy();
      resolve([]);
    });
    req.end();
  });
}

// Parse schedule time string into Date
function parseScheduleTime(timeStr) {
  const now = Date.now();

  // Try parsing as relative time (5m, 1h, 2h30m, etc.)
  const relativeMatch = timeStr.match(/^(\d+h)?(\d+m)?(\d+s)?$/i);
  if (relativeMatch) {
    const hours = relativeMatch[1]
      ? parseInt(relativeMatch[1], 10) * 3600000
      : 0;
    const minutes = relativeMatch[2]
      ? parseInt(relativeMatch[2], 10) * 60000
      : 0;
    const seconds = relativeMatch[3]
      ? parseInt(relativeMatch[3], 10) * 1000
      : 0;
    return now + hours + minutes + seconds;
  }

  // Try parsing as absolute time (HH:MM or HH:MM:SS)
  const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (timeMatch) {
    const [, hour, minute, second] = timeMatch;
    const date = new Date();
    date.setHours(
      parseInt(hour, 10),
      parseInt(minute, 10),
      second ? parseInt(second, 10) : 0,
      0,
    );
    if (date.getTime() <= now) {
      date.setDate(date.getDate() + 1); // Schedule for tomorrow if time has passed
    }
    return date.getTime();
  }

  return null;
}

// Format duration in human-readable form
function formatDuration(ms) {
  if (ms <= 0) return "now";

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function addTask(task) {
  let content = fs.existsSync(TASKS_FILE)
    ? fs.readFileSync(TASKS_FILE, "utf8")
    : "# Pending Tasks\n";
  if (!content.includes("# Pending Tasks")) {
    content = "# Pending Tasks\n" + content;
  }
  content = content.replace(
    "# Pending Tasks\n",
    `# Pending Tasks\n- [ ] ${task}\n`,
  );
  fs.writeFileSync(TASKS_FILE, content);
}

function removeTaskFromPending(task) {
  if (!fs.existsSync(TASKS_FILE)) return false;
  let content = fs.readFileSync(TASKS_FILE, "utf8");
  const originalContent = content;

  // Remove the specific task from pending tasks
  content = content.replace(
    new RegExp(
      `- \\[ \\] ${task.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\n?`,
      "s",
    ),
    "",
  );

  // Clean up empty lines and restore the header if needed
  content = content.replace("# Pending Tasks\n\n", "# Pending Tasks\n");

  if (content !== originalContent) {
    fs.writeFileSync(TASKS_FILE, content);
    log(`Removed task from pending: ${task}`);
    return true;
  }
  return false;
}

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

async function runCycle(interaction) {
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
  const task = tasks[0];
  if (interaction) interaction.followUp(`Working on task: ${task}`);
  log(`Working on task: ${task}`);

  const apiKey = await getGeminiApiKey();
  if (!apiKey) {
    const errorMsg = "Could not obtain API key for Gemini.";
    if (interaction) interaction.followUp(errorMsg);
    log(errorMsg);
    return;
  }

  const repoBrief = fs.existsSync(REPO_BRIEF_FILE)
    ? fs.readFileSync(REPO_BRIEF_FILE, "utf8")
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
When you are working on a task, you can report your status by printing a line starting with [STATUS] followed by your current activity. This status will be displayed in Discord.
Then, commit the code to the feature branch and open a PR using gh cli.
When the task is complete, mark it as done in the task file (${TASKS_FILE}) by changing [ ] to [x].
make sure your final message is a summary of the work that was done, or an explanation of the failure.

if needed, previous sessions can be found in ~/.pi/agent/sessions/
use lowercase writing and a semi-informal tone.

Context:
- Task File: ${TASKS_FILE}
- Current working directory: ${config.workDir}
`;

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
    log(`Failed to start pi process: ${err.message}`);
    currentStatus = `Failed to start.`;
    await updateDiscordStatus(true);
    if (interaction)
      interaction.followUp(`Failed to start pi process: ${err.message}`);
  });

  let piOutput = "";
  let piError = "";
  let statusMessage = null;
  let lastStatusUpdate = 0;
  const UPDATE_INTERVAL = 5000;
  let currentStatus = "Starting...";
  let pausedTaskId = null;

  if (interaction) {
    statusMessage = await interaction.followUp(
      `**Current Task:** ${task}\n**Status:** ${currentStatus}`,
    );

    // Create a session for this task run
    try {
      const session = SESSIONS.createSession(task, {
        discordMessageId: statusMessage.id,
        discordChannelId: statusMessage.channelId,
        workspacePath: config.workDir,
        prompt: prompt.substring(0, 2000), // Store prompt snippet
      });
      log(`Created session ${session.id} for task: ${task}`);
    } catch (e) {
      log(`Failed to create session: ${e.message}`);
    }
  }

  const updateDiscordStatus = async (force = false) => {
    if (!statusMessage) return;
    const now = Date.now();
    if (force || now - lastStatusUpdate > UPDATE_INTERVAL) {
      lastStatusUpdate = now;
      try {
        await statusMessage.edit(
          `**Current Task:** ${task}\n**Status:** ${currentStatus}`,
        );
      } catch (e) {
        log(`Failed to update Discord status: ${e.message}`);
      }
    }
  };

  piProcess.stdout.on("data", (data) => {
    const s = data.toString();
    piOutput += s;
    process.stdout.write(s);

    const lines = s.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Try to parse as JSON event (for --mode json)
      try {
        const event = JSON.parse(trimmed);

        // Handle message events (start, update, end)
        if (event.message && event.message.content) {
          for (const content of event.message.content) {
            let text = "";
            if (content.type === "text") text = content.text;
            else if (content.type === "thinking") text = content.thinking;

            if (text) {
              const lines = text.split("\n");
              for (const line of lines) {
                const trimmedLine = line.trim();
                if (trimmedLine.includes("[STATUS]")) {
                  currentStatus = trimmedLine.split("[STATUS]")[1].trim();
                  updateDiscordStatus();
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
                  currentStatus = trimmedLine.split("[STATUS]")[1].trim();
                  updateDiscordStatus();
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

        if (quotaErrorInfo) {
          log(`Quota error detected in JSON: ${quotaErrorInfo.errorMessage}`);
          const hasTime =
            quotaErrorInfo.resetAfterMs && quotaErrorInfo.resetAfterMs > 0;
          const waitInfo = hasTime
            ? `until ${formatDuration(quotaErrorInfo.resetAfterMs)}`
            : "until quota resets (estimated 1 hour)";
          currentStatus = `Quota exhausted. Pausing task ${waitInfo}.`;

          // Pause the task
          const paused = SCHEDULER.pauseTask(task, quotaErrorInfo);
          pausedTaskId = paused.id;

          // Remove the task from pending tasks in tasks.md to prevent retry
          removeTaskFromPending(task);

          // Schedule task as a scheduled task for after quota reset
          SCHEDULER.scheduleTask(task, paused.resumeAt, "quota_resume");
          updateDiscordStatus(true);
        }
      } catch (e) {
        // Not valid JSON, treat as plain text
        // Look for [STATUS] in plain text lines
        if (trimmed.includes("[STATUS]")) {
          currentStatus = trimmed.split("[STATUS]")[1].trim();
          updateDiscordStatus();
        }

        // Check for quota errors in plain text
        if (SCHEDULER.isQuotaError(trimmed)) {
          const errorInfo = SCHEDULER.parseQuotaError(trimmed);
          if (errorInfo) {
            log(`Quota error detected in text: ${errorInfo.errorMessage}`);
            currentStatus = `Quota exhausted. Pausing task until ${formatDuration(
              errorInfo.resetAfterMs,
            )}.`;
            updateDiscordStatus(true);

            // Pause the task
            const paused = SCHEDULER.pauseTask(task, errorInfo);
            pausedTaskId = paused.id;

            // Remove the task from pending tasks in tasks.md to prevent retry
            removeTaskFromPending(task);

            // Schedule task as a scheduled task for after quota reset
            SCHEDULER.scheduleTask(task, paused.resumeAt, "quota_resume");
          }
        }
      }
    }
  });

  piProcess.stderr.on("data", (data) => {
    const s = data.toString();
    piError += s;
    process.stderr.write(s);

    // Also check stderr for quota errors
    if (SCHEDULER.isQuotaError(s)) {
      const errorInfo = SCHEDULER.parseQuotaError(s);
      if (errorInfo) {
        log(`Quota error detected in stderr: ${errorInfo.errorMessage}`);
        const hasTime = errorInfo.resetAfterMs && errorInfo.resetAfterMs > 0;
        const waitInfo = hasTime
          ? `until ${formatDuration(errorInfo.resetAfterMs)}`
          : "until quota resets (estimated 1 hour)";
        currentStatus = `Quota exhausted. Pausing task ${waitInfo}.`;
        updateDiscordStatus(true);

        // Pause the task
        const paused = SCHEDULER.pauseTask(task, errorInfo);
        pausedTaskId = paused.id;

        // Remove the task from pending tasks in tasks.md to prevent retry
        removeTaskFromPending(task);

        // Schedule task as a scheduled task for after quota reset
        SCHEDULER.scheduleTask(task, paused.resumeAt, "quota_resume");
      }
    }
  });

  piProcess.on("close", async (code) => {
    isRunning = false;
    // Check if this was a quota pause
    const schedule = SCHEDULER.loadSchedule();
    const isQuotaPause = schedule.scheduled.some(
      (t) => t.task === task && t.reason === "quota_resume",
    );

    if (code === 0) {
      log("pi finished successfully.");
      currentStatus = "Completed successfully.";
      await updateDiscordStatus(true);

      // Complete the session
      try {
        SESSIONS.completeSession(statusMessage.id);
        SESSIONS.archiveCompletedSessions();
      } catch (e) {
        log(`Failed to complete session: ${e.message}`);
      }

      if (interaction) {
        const cleanedOutput = stripAnsi(piOutput.trim());
        const truncatedOutput =
          cleanedOutput.length > 1900
            ? "..." + cleanedOutput.slice(-1900)
            : cleanedOutput;
        interaction.followUp(
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
    } else if (code !== 0 && isQuotaPause && pausedTaskId) {
      // Task was paused due to quota, already scheduled for resume
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
          cleanedOutput.length > 1500
            ? "..." + cleanedOutput.slice(-1500)
            : cleanedOutput;

        let response = `Task ${task} was paused due to Google API quota exhaustion. Will resume automatically when quota resets.`;

        // Include the actual error message that was detected
        const pausedTask = schedule.paused.find((t) => t.id === pausedTaskId);
        if (pausedTask?.errorInfo?.errorMessage) {
          const errorPreview = pausedTask.errorInfo.errorMessage.slice(0, 500);
          response += `\n\n**Original Error:**\n\`\`\`\n${errorPreview}${errorPreview.length >= 500 ? "..." : ""}\n\`\`\``;
        }

        if (truncatedOutput) {
          response += `\n\n**Output so far:**\n\`\`\`\n${truncatedOutput}\n\`\`\``;
        }
        interaction.followUp(response);
      }

      // If autoNext is enabled, start the next task (quota-paused task was already removed from pending)
      if (config.autoNext) {
        log("autoNext is enabled, starting next task after quota pause...");
        setTimeout(() => {
          runCycle();
        }, 5000);
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
      }
      log(`pi failed with code ${code}.`);
    }
  });
}

function getPendingTasks() {
  if (!fs.existsSync(TASKS_FILE)) return [];
  const content = fs.readFileSync(TASKS_FILE, "utf8");
  const matches = content.match(/- \[ \] (.*)/g);
  if (!matches) return [];
  const tasks = matches.map((m) => m.slice(6).trim());
  return [...new Set(tasks)];
}

client.login(process.env.DISCORD_TOKEN);
