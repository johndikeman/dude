/**
 * Enhanced test script for the self-audit feature.
 * This tests the audit functionality with mocking and comprehensive coverage.
 */

import fs from "fs";
import path from "path";
import os from "os";
import * as AUDIT from "./src/audit.js";
import * as SESSIONS from "./src/sessions.js";

const TEST_DIR = path.join(os.tmpdir(), `dude-audit-test-${Date.now()}`);
const SESSIONS_DIR = path.join(TEST_DIR, ".pi/agent/sessions");
const BIN_DIR = path.join(TEST_DIR, "bin");

// Setup test environment
function setup() {
  if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  }
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
  }

  process.env.DUDE_CONFIG_DIR = TEST_DIR;
  process.env.HOME = TEST_DIR;
  process.env.PATH = `${BIN_DIR}:${process.env.PATH}`;

  // Create a mock 'pi' executable
  const piMock = path.join(BIN_DIR, "pi");
  fs.writeFileSync(piMock, `#!/usr/bin/env node
import fs from "fs";
const output = \`Summary: Done well.
Pain Points: None.
Tasks:
- [TASK] improve documentation
- [TASK] add more logs\`;
console.log(output);
`);
  fs.chmodSync(piMock, 0o755);
}

function cleanup() {
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch (e) {}
}

async function runTests() {
  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (!condition) {
      throw new Error(message || "Assertion failed");
    }
  }

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e) {
      console.log(`  ✗ ${name}: ${e.message}`);
      console.error(e);
      failed++;
    }
  }

  console.log("Starting enhanced audit feature tests...\n");

  setup();

  await test("runAudit processes un-audited completed sessions", async () => {
    // 1. Create a completed session
    const sessions = {
      active: [],
      completed: [
        {
          id: "session-1",
          task: "test task 1",
          status: "completed",
          createdAt: Date.now(),
          completedAt: Date.now(),
          workspacePath: "/home/ubuntu/dude-workspace",
          audited: false
        }
      ]
    };
    SESSIONS.saveSessions(sessions);

    // 2. Create a mock log file for this session
    const workspaceSafe = "home-ubuntu-dude-workspace";
    const sessionDir = path.join(SESSIONS_DIR, `--${workspaceSafe}--`);
    fs.mkdirSync(sessionDir, { recursive: true });
    
    const now = new Date();
    const timestamp = now.toISOString().replace(/:/g, "-").replace(/\..+/, "") + "-000Z";
    const logFile = path.join(sessionDir, `${timestamp}.jsonl`);
    fs.writeFileSync(logFile, '{"log": "some log content"}\n');

    // 3. Run audit
    await AUDIT.runAudit("mock-model", "mock-provider");

    // 4. Verify session is marked as audited
    const updatedSessions = SESSIONS.loadSessions();
    assert(updatedSessions.completed[0].audited === true, "Session should be marked as audited");

    // 5. Verify tasks were added to tasks.md
    const tasksFile = path.join(TEST_DIR, "tasks.md");
    assert(fs.existsSync(tasksFile), "tasks.md should be created");
    const tasksContent = fs.readFileSync(tasksFile, "utf8");
    assert(tasksContent.includes("[AUDIT] improve documentation (from session session-1)"), "Task 1 should be added");
    assert(tasksContent.includes("[AUDIT] add more logs (from session session-1)"), "Task 2 should be added");
  });

  await test("runAudit skips already audited sessions", async () => {
    // Reset sessions
    const sessions = {
      active: [],
      completed: [
        {
          id: "session-2",
          task: "test task 2",
          status: "completed",
          createdAt: Date.now(),
          completedAt: Date.now(),
          workspacePath: "/home/ubuntu/dude-workspace",
          audited: true
        }
      ]
    };
    SESSIONS.saveSessions(sessions);
    
    // Clear tasks.md
    const tasksFile = path.join(TEST_DIR, "tasks.md");
    fs.writeFileSync(tasksFile, "# Pending Tasks\n");

    await AUDIT.runAudit("mock-model", "mock-provider");

    const tasksContent = fs.readFileSync(tasksFile, "utf8");
    assert(!tasksContent.includes("session-2"), "Should not add tasks for already audited session");
  });

  await test("findLogFile handles path variations", async () => {
    const workspacePath = "/home/ubuntu/dude-workspace";
    const safePath = workspacePath.replace(/\//g, "-");
    
    const expectedVariations = [
      safePath,
      `-${safePath}`,
      `${safePath}-`,
      `-${safePath}-`,
      `--${safePath.substring(1)}--`
    ];

    for (const v of expectedVariations) {
      // Clear previous directories
      const existing = fs.readdirSync(SESSIONS_DIR);
      for (const d of existing) {
        fs.rmSync(path.join(SESSIONS_DIR, d), { recursive: true, force: true });
      }

      const sessionDir = path.join(SESSIONS_DIR, v);
      fs.mkdirSync(sessionDir, { recursive: true });
      
      const now = new Date();
      const timestamp = now.toISOString().replace(/:/g, "-").replace(/\..+/, "") + "-000Z";
      const logFile = path.join(sessionDir, `${timestamp}.jsonl`);
      fs.writeFileSync(logFile, '{"log": "some log content"}\n');

      const session = {
        id: `session-${v}`,
        task: `test task ${v}`,
        status: "completed",
        createdAt: now.getTime(),
        workspacePath: workspacePath,
        audited: false
      };
      
      const sessions = { active: [], completed: [session] };
      SESSIONS.saveSessions(sessions);

      // Create dummy agent.log to capture output
      const agentLog = path.join(TEST_DIR, "agent.log");
      if (fs.existsSync(agentLog)) fs.unlinkSync(agentLog);

      await AUDIT.runAudit("mock-model", "mock-provider");

      const logOutput = fs.existsSync(agentLog) ? fs.readFileSync(agentLog, "utf8") : "";
      assert(!logOutput.includes("Could not find log file"), `Should have found log file for variation ${v}. Log: ${logOutput}`);
    }
  });

  await test("auditSession truncates long logs", async () => {
    const workspacePath = "/home/ubuntu/dude-workspace";
    const safePath = workspacePath.replace(/\//g, "-");
    const v = `--${safePath.substring(1)}--`;
    const sessionDir = path.join(SESSIONS_DIR, v);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    const now = new Date();
    const timestamp = now.toISOString().replace(/:/g, "-").replace(/\..+/, "") + "-000Z";
    const logFile = path.join(sessionDir, `${timestamp}.jsonl`);
    
    // Create a log > 50KB
    const largeContent = "x".repeat(60000);
    fs.writeFileSync(logFile, largeContent);

    const session = {
      id: "session-large",
      task: "large task",
      status: "completed",
      createdAt: now.getTime(),
      workspacePath: workspacePath,
      audited: false
    };
    
    const sessions = { active: [], completed: [session] };
    SESSIONS.saveSessions(sessions);

    const piInputFile = path.join(TEST_DIR, "pi_input.txt");
    const piMock = path.join(BIN_DIR, "pi");
    fs.writeFileSync(piMock, `#!/usr/bin/env node
import fs from "fs";
fs.writeFileSync("${piInputFile}", process.argv.join(" "));
console.log("Summary: ok\\nTasks:");
`);

    await AUDIT.runAudit("mock-model", "mock-provider");
    
    const piInput = fs.readFileSync(piInputFile, "utf8");
    assert(piInput.includes("... [truncated] ..."), "Log should be truncated in the prompt");
  });

  console.log(`\n=== Results ===`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
