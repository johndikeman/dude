#!/usr/bin/env node
require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");
const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

const TASKS_FILE = path.join(process.cwd(), "tasks.md");
const CONFIG_FILE = path.join(process.cwd(), "config.json");
const LOG_FILE = path.join(process.cwd(), "agent.log");
const REPO_BRIEF_FILE = path.join(process.cwd(), "REPO_BRIEF.md");
const SCHEDULER = require("./scheduler");

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
};

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
  new SlashCommandBuilder().setName("help").setDescription("Show help message"),
  new SlashCommandBuilder()
    .setName("modelcode")
    .setDescription("change the gemini model code")
    .addStringOption((option) =>
      option
        .setName("code")
        .setDescription(
          "the model code, ie gemini-3-flash-preview, gemini-3-pro-preview, qwen3.5:122b, gemini-2.5-pro",
        )
        .setRequired(true),
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

  // Initial check for scheduled tasks on startup
  await checkAndRunScheduledTasks();
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
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, options } = interaction;

  if (commandName === "task") {
    const task = options.getString("description");
    addTask(task);
    await interaction.reply(`Task added: ${task}`);
  }

  if (commandName === "tasks") {
    const tasks = getPendingTasks();
    if (tasks.length === 0) {
      await interaction.reply("No pending tasks.");
    } else {
      const list = tasks.map((t, i) => `${i + 1}. ${t}`).join("\n");
      await interaction.reply(`**Pending Tasks:**\n${list}`);
    }
  }

  if (commandName === "status") {
    const tasks = getPendingTasks();
    const status = [
      `**Status Report**`,
      `Working Directory: \`${config.workDir}\``,
      `Model: ${MODEL_CODE}`,
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
        `/restart - Restart the agent`,
        `/help - Show this message`,
      ].join("\n"),
    );
  }
});

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
  const tasks = getPendingTasks();
  if (tasks.length === 0) {
    if (interaction) interaction.followUp("No pending tasks.");
    return;
  }

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
Create a feature branch to work on, pull in the most recent 'main' branch in case another user has made changes.
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
    "-p",
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

  let piOutput = "";
  let statusMessage = null;
  let lastStatusUpdate = 0;
  const UPDATE_INTERVAL = 5000;
  let currentStatus = "Starting...";
  let pausedTaskId = null;

  if (interaction) {
    statusMessage = await interaction.followUp(
      `**Current Task:** ${task}\n**Status:** ${currentStatus}`,
    );
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
      if (line.includes("[STATUS]")) {
        currentStatus = line.split("[STATUS]")[1].trim();
        updateDiscordStatus();
      }

      // Check for quota errors in stdout
      if (SCHEDULER.isQuotaError(line)) {
        const errorInfo = SCHEDULER.parseQuotaError(line);
        if (errorInfo) {
          log(`Quota error detected: ${errorInfo.errorMessage}`);
          currentStatus = `Quota exhausted. Pausing task until ${formatDuration(
            errorInfo.resetAfterMs,
          )}.`;
          updateDiscordStatus(true);

          // Pause the task
          const paused = SCHEDULER.pauseTask(task, errorInfo);
          pausedTaskId = paused.id;

          // Schedule task as a scheduled task for after quota reset
          SCHEDULER.scheduleTask(task, paused.resumeAt, "quota_resume");
        }
      }
    }
  });

  piProcess.stderr.on("data", (data) => {
    const s = data.toString();
    process.stderr.write(s);

    // Also check stderr for quota errors
    if (SCHEDULER.isQuotaError(s)) {
      const errorInfo = SCHEDULER.parseQuotaError(s);
      if (errorInfo) {
        log(`Quota error detected in stderr: ${errorInfo.errorMessage}`);
        currentStatus = `Quota exhausted. Pausing task until ${formatDuration(
          errorInfo.resetAfterMs,
        )}.`;
        updateDiscordStatus(true);

        // Pause the task
        const paused = SCHEDULER.pauseTask(task, errorInfo);
        pausedTaskId = paused.id;

        // Schedule task as a scheduled task for after quota reset
        SCHEDULER.scheduleTask(task, paused.resumeAt, "quota_resume");
      }
    }
  });

  piProcess.on("close", async (code) => {
    // Check if this was a quota pause
    const schedule = SCHEDULER.loadSchedule();
    const isQuotaPause = schedule.scheduled.some(
      (t) => t.task === task && t.reason === "quota_resume",
    );

    if (code === 0) {
      log("pi finished successfully.");
      currentStatus = "Completed successfully.";
      await updateDiscordStatus(true);
      if (interaction)
        interaction.followUp(
          piOutput || "Task completed successfully (no output).",
        );
    } else if (code !== 0 && isQuotaPause && pausedTaskId) {
      // Task was paused due to quota, already scheduled for resume
      log(`Task ${task} was paused due to quota, scheduled for resume.`);
      currentStatus = `Paused (quota). Resumes in ${formatDuration(
        schedule.scheduled.find(
          (t) => t.task === task && t.reason === "quota_resume",
        )?.runAt - Date.now() || 0,
      )}.`;
      await updateDiscordStatus(true);
      if (interaction) {
        interaction.followUp(
          `Task ${task} was paused due to Google API quota exhaustion. Will resume automatically when quota resets.`,
        );
      }
    } else {
      const errorMsg = `pi failed with code ${code}\n\n${piOutput}`;
      currentStatus = `Failed with code ${code}.`;
      await updateDiscordStatus(true);
      if (interaction) interaction.followUp(errorMsg);
      log(errorMsg);
    }
  });
}

function getPendingTasks() {
  if (!fs.existsSync(TASKS_FILE)) return [];
  const content = fs.readFileSync(TASKS_FILE, "utf8");
  const matches = content.match(/- \[ \] (.*)/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(6));
}

client.login(process.env.DISCORD_TOKEN);
