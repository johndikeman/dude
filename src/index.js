require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

const OWNER_ID = process.env.OWNER_ID;
const TASKS_FILE = path.join(__dirname, '../tasks.md');
const CONFIG_FILE = path.join(__dirname, '../config.json');
const LOG_FILE = path.join(__dirname, '../agent.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {}
}

let config = {
  workDir: process.cwd(),
};

if (fs.existsSync(CONFIG_FILE)) {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

client.on('ready', () => {
  log(`Logged in as ${client.user.tag}!`);
  log(`Current working directory: ${config.workDir}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (OWNER_ID && message.author.id !== OWNER_ID) return;

  const content = message.content.trim();

  if (content.startsWith('!workdir ')) {
    const newDir = content.slice(9).trim();
    if (fs.existsSync(newDir)) {
      config.workDir = path.resolve(newDir);
      saveConfig();
      message.reply(`Working directory updated to: ${config.workDir}`);
    } else {
      message.reply(`Directory does not exist: ${newDir}`);
    }
  }

  if (content.startsWith('!task ')) {
    const task = content.slice(6).trim();
    addTask(task);
    message.reply(`Task added: ${task}`);
  }

  if (content === '!tasks') {
    const tasks = getPendingTasks();
    if (tasks.length === 0) {
      message.reply('No pending tasks.');
    } else {
      const list = tasks.map((t, i) => `${i + 1}. ${t}`).join('\n');
      message.reply(`**Pending Tasks:**\n${list}`);
    }
  }

  if (content === '!status') {
    const tasks = getPendingTasks();
    const status = [
      `**Status Report**`,
      `Working Directory: \`${config.workDir}\``,
      `Pending Tasks: ${tasks.length}`,
      tasks.length > 0 ? `Next Task: ${tasks[0]}` : '',
    ].filter(Boolean).join('\n');
    message.reply(status);
  }

  if (content === '!restart') {
    await message.reply('Restarting agent...');
    process.exit(0);
  }

  if (content === '!start') {
    message.reply('Starting self-improvement cycle...');
    runCycle(message);
  }
  
  if (content === '!help') {
    message.reply([
      `**Commands:**`,
      `!task <desc> - Add a task`,
      `!tasks - List tasks`,
      `!status - Show status`,
      `!workdir <path> - Change working directory`,
      `!start - Start working on the next task`,
      `!restart - Exit and let systemd restart the agent`,
      `!help - Show this message`
    ].join('\n'));
  }
});

function addTask(task) {
  let content = fs.existsSync(TASKS_FILE) ? fs.readFileSync(TASKS_FILE, 'utf8') : '# Pending Tasks\n';
  if (!content.includes('# Pending Tasks')) {
    content = '# Pending Tasks\n' + content;
  }
  content = content.replace('# Pending Tasks\n', `# Pending Tasks\n- [ ] ${task}\n`);
  fs.writeFileSync(TASKS_FILE, content);
}

async function getGeminiApiKey() {
  try {
    const token = execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
    const project = execSync('gcloud config get-value project', { encoding: 'utf8' }).trim();
    if (!project || project === '(unset)') {
      console.warn('Google Cloud project is unset.');
    }
    return JSON.stringify({ token, projectId: project });
  } catch (err) {
    console.error('Failed to get Google Cloud token. Make sure gcloud is logged in.');
    return null;
  }
}

async function runCycle(message) {
  const tasks = getPendingTasks();
  if (tasks.length === 0) {
    if (message) message.reply('No pending tasks.');
    return;
  }

  const task = tasks[0];
  if (message) message.reply(`Working on task: ${task}`);
  console.log(`Working on task: ${task}`);

  const apiKey = await getGeminiApiKey();
  if (!apiKey) {
    const errorMsg = 'Could not obtain API key for Gemini. Make sure you are logged in via `gcloud auth login`.';
    if (message) message.reply(errorMsg);
    console.error(errorMsg);
    return;
  }

  const branchName = `task-${Date.now()}`;
  try {
    execSync(`git checkout -b ${branchName}`, { cwd: config.workDir });
  } catch (e) {
    console.error('Failed to create branch. Working on current branch.');
  }

  const prompt = `You are a self-improving AI agent. 
Current Task: ${task}

Your goal is to implement this task in the current directory (${config.workDir}).
If the working directory is the agent's own repository, you are improving yourself.
Once you have implemented the task, please ensure you have tested the changes (e.g., via 'npm test' or running the code).
Do not create PRs or commit changes; I will handle that once you finish this process.
Just perform the requested changes and exit.

Context:
- Task File: ${TASKS_FILE}
- Current working directory: ${config.workDir}
`;
  
  const piArgs = [
    '--provider', 'google-gemini-cli',
    '--model', 'gemini-2.5-pro',
    '--api-key', apiKey,
    '-p', prompt
  ];

  console.log(`Executing: pi ${piArgs.join(' ')} in ${config.workDir}`);

  const piProcess = spawn('pi', piArgs, { 
    stdio: 'inherit',
    cwd: config.workDir
  });

  piProcess.on('close', (code) => {
    if (code === 0) {
      console.log('pi finished successfully.');
      if (message) message.reply(`Task "${task}" implemented by pi. Creating PR...`);
      
      try {
        execSync('git add .', { cwd: config.workDir });
        execSync(`git commit -m "Implement task: ${task}"`, { cwd: config.workDir });
        execSync(`git push origin ${branchName}`, { cwd: config.workDir });
        const prUrl = execSync(`gh pr create --title "Implement task: ${task}" --body "Automated PR from self-improving agent for task: ${task}"`, { 
          encoding: 'utf8',
          cwd: config.workDir 
        }).trim();
        if (message) message.reply(`PR created: ${prUrl}`);
        markTaskDone(task);
      } catch (err) {
        const errorMsg = `Failed to commit/PR: ${err.message}`;
        if (message) message.reply(errorMsg);
        console.error(errorMsg);
      }
    } else {
      const errorMsg = `pi failed with code ${code}`;
      if (message) message.reply(errorMsg);
      console.error(errorMsg);
    }
  });
}

function getPendingTasks() {
  if (!fs.existsSync(TASKS_FILE)) return [];
  const content = fs.readFileSync(TASKS_FILE, 'utf8');
  const matches = content.match(/- \[ \] (.*)/g);
  if (!matches) return [];
  return matches.map(m => m.slice(6));
}

function markTaskDone(task) {
  let content = fs.readFileSync(TASKS_FILE, 'utf8');
  content = content.replace(`- [ ] ${task}`, `- [x] ${task}`);
  fs.writeFileSync(TASKS_FILE, content);
}

client.login(process.env.DISCORD_TOKEN);
