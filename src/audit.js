import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import * as SESSIONS from "./sessions.js";

const CONFIG_DIR = process.env.DUDE_CONFIG_DIR || process.cwd();
const LOG_FILE = path.join(CONFIG_DIR, "agent.log");
const TASKS_FILE = path.join(CONFIG_DIR, "tasks.md");

function log(msg) {
  const line = `[${new Date().toISOString()}] [AUDIT] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (e) {}
}

function addTask(task) {
  let content = fs.existsSync(TASKS_FILE)
    ? fs.readFileSync(TASKS_FILE, "utf8")
    : "# Pending Tasks\n";
  
  // Check if task already exists as pending
  if (content.includes(`- [ ] ${task}`)) {
    log(`Task already exists in pending: ${task}`);
    return;
  }

  if (!content.includes("# Pending Tasks")) {
    content = "# Pending Tasks\n" + content;
  }
  content = content.replace(
    "# Pending Tasks\n",
    `# Pending Tasks\n- [ ] ${task}\n`,
  );
  fs.writeFileSync(TASKS_FILE, content);
}

function findLogFile(session) {
  const sessionsDir = path.join(process.env.HOME, ".pi/agent/sessions");
  const workspacePath = session.workspacePath || "/home/ubuntu/dude-workspace";
  const safePath = workspacePath.replace(/\//g, "-");
  
  // Try different variations of safe path naming
  const variations = [
    safePath,
    `-${safePath}`,
    `${safePath}-`,
    `-${safePath}-`,
    `--${safePath.substring(1)}--`, // Matches --home-ubuntu-dude-workspace--
  ];

  let sessionDir = null;
  for (const v of variations) {
    const dir = path.join(sessionsDir, v);
    if (fs.existsSync(dir)) {
      sessionDir = dir;
      break;
    }
  }

  if (!sessionDir) {
    log(`Session directory not found for ${workspacePath}`);
    return null;
  }

  const files = fs.readdirSync(sessionDir);
  const sessionTime = new Date(session.createdAt).getTime();

  const closest = files
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const match = f.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/);
      if (!match) return null;
      const timeStr = match[1];
      const parts = timeStr.replace("Z", "").split(/[T-]/);
      const d = new Date(Date.UTC(
        parseInt(parts[0], 10),
        parseInt(parts[1], 10) - 1,
        parseInt(parts[2], 10),
        parseInt(parts[3], 10),
        parseInt(parts[4], 10),
        parseInt(parts[5], 10),
        parseInt(parts[6], 10)
      ));
      return { name: f, time: d.getTime() };
    })
    .filter((f) => f && f.time >= sessionTime - 5000 && f.time < sessionTime + 60000)
    .sort((a, b) => Math.abs(a.time - sessionTime) - Math.abs(b.time - sessionTime))[0];

  return closest ? path.join(sessionDir, closest.name) : null;
}

export async function runAudit(modelCode, modelProvider) {
  log("Starting self-audit...");
  const sessions = SESSIONS.loadSessions();

  // Audit completed/interrupted/failed sessions that haven't been audited yet
  const toAudit = sessions.completed.filter((s) => !s.audited);

  if (toAudit.length === 0) {
    log("No new sessions to audit.");
    return;
  }

  log(`Auditing ${toAudit.length} sessions...`);

  for (const session of toAudit) {
    try {
      await auditSession(session, modelCode, modelProvider);
      session.audited = true;
      // Save after each session to avoid re-auditing if interrupted
      SESSIONS.saveSessions(sessions);
    } catch (e) {
      log(`Failed to audit session ${session.id}: ${e.message}`);
    }
  }

  log("Self-audit completed.");
}

async function auditSession(session, modelCode, modelProvider) {
  log(`Auditing session ${session.id}: ${session.task.substring(0, 50)}...`);
  
  const logPath = findLogFile(session);
  if (!logPath) {
    log(`Could not find log file for session ${session.id}`);
    return;
  }

  let logContent = fs.readFileSync(logPath, "utf8");
  
  // Limit log size to ~50KB to avoid E2BIG and token limits
  if (logContent.length > 50000) {
    logContent = logContent.substring(0, 25000) + "\n... [truncated] ...\n" + logContent.substring(logContent.length - 25000);
  }
  
  const prompt = `You are a senior AI engineer auditing the performance of an autonomous agent.
Original Task: ${session.task}
Session ID: ${session.id}

Session Log (JSONL format):
---
${logContent}
---

Evaluate the session. 
1. Did it accomplish the goal successfully?
2. Were there any pain points, loops, or inefficiencies?
3. Are there any improvements needed to the agent's tools or instructions?

If you find any pain points or needed improvements, suggest them as new tasks.
Format your response as:
Summary: <brief summary of evaluation>
Pain Points: <list of pain points found>
Tasks:
- [TASK] <task description 1>
- [TASK] <task description 2>

If no tasks are needed, just say "No tasks needed."`;

  const piArgs = [
    "--provider", modelProvider,
    "--model", modelCode,
    "--mode", "json",
    prompt
  ];

  return new Promise((resolve, reject) => {
    const piProcess = spawn("pi", piArgs);
    let output = "";

    piProcess.stdout.on("data", (data) => {
      output += data.toString();
    });

    piProcess.on("close", (code) => {
      if (code === 0) {
        // Parse output for tasks
        const lines = output.split("\n");
        let tasksFound = 0;
        for (const line of lines) {
          if (line.includes("[TASK]")) {
            const task = line.split("[TASK]")[1].trim();
            if (task) {
              log(`Adding task from audit: ${task}`);
              addTask(`[AUDIT] ${task} (from session ${session.id})`);
              tasksFound++;
            }
          }
        }
        log(`Audit of session ${session.id} finished. ${tasksFound} tasks added.`);
        resolve();
      } else {
        reject(new Error(`pi process exited with code ${code}`));
      }
    });
  });
}
