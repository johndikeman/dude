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
  new SlashCommandBuilder().setName("help").setDescription("Show help message"),
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
});

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

  if (commandName === "help") {
    await interaction.reply(
      [
        `**Commands:**`,
        `/task <desc> - Add a task`,
        `/tasks - List tasks`,
        `/status - Show status`,
        `/workdir <path> - Change working directory`,
        `/start - Start working on the next task`,
        `/restart - Restart the agent`,
        `/help - Show this message`,
      ].join("\n"),
    );
  }
});

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

  const prompt = `You are a self-improving AI agent. 
Current Task: ${task}
Current date: ${new Date().toLocaleString("en-US")}
Your goal is to implement this task. your workspace is in (${config.workDir}).
if the task is to improve yourself, this will be in the dude/ directory. if the directory does not exist, you can use the gh cli to clone johndikeman/dude.
you can clone other repositories if needed.
Create a feature branch to work on.
Once you have implemented the task, please ensure you have tested the changes (e.g., via 'npm test' or running the code).
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
    "google-gemini-cli",
    "--model",
    "gemini-3-flash-preview",
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

  piProcess.stdout.on("data", (data) => {
    const s = data.toString();
    piOutput += s;
    process.stdout.write(s);
  });

  piProcess.stderr.on("data", (data) => {
    const s = data.toString();
    process.stderr.write(s);
  });

  piProcess.on("close", (code) => {
    if (code === 0) {
      log("pi finished successfully.");
      if (interaction) interaction.followUp(piOutput || "Task completed successfully (no output).");
    } else {
      const errorMsg = `pi failed with code ${code}\n\n${piOutput}`;
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
