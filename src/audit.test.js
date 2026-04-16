import fs from "fs";
import path from "path";
import os from "os";
import * as AUDIT from "./audit.js";
import * as SESSIONS from "./sessions.js";

const TEST_DIR = path.join(os.tmpdir(), `dude-audit-unit-test-${Date.now()}`);
const SESSIONS_DIR = path.join(TEST_DIR, ".pi/agent/sessions");
const BIN_DIR = path.join(TEST_DIR, "bin");

function setup() {
  if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

  process.env.DUDE_CONFIG_DIR = TEST_DIR;
  process.env.HOME = TEST_DIR;
  process.env.PATH = `${BIN_DIR}:${process.env.PATH}`;

  const piMock = path.join(BIN_DIR, "pi");
  fs.writeFileSync(piMock, `#!/usr/bin/env node
console.log("Summary: ok\\nTasks:\\n- [TASK] unit test task");
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
    if (!condition) throw new Error(message || "Assertion failed");
  }

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e) {
      console.log(`  ✗ ${name}: ${e.message}`);
      failed++;
    }
  }

  console.log("\nRunning src/audit.js unit tests...\n");
  setup();

  await test("runAudit adds tasks from LLM output", async () => {
    const sessions = {
      active: [],
      completed: [{
        id: "unit-1",
        task: "unit task",
        status: "completed",
        createdAt: Date.now(),
        workspacePath: "/home/ubuntu/dude-workspace",
        audited: false
      }]
    };
    SESSIONS.saveSessions(sessions);

    const sessionDir = path.join(SESSIONS_DIR, "--home-ubuntu-dude-workspace--");
    fs.mkdirSync(sessionDir, { recursive: true });
    const logFile = path.join(sessionDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
    fs.writeFileSync(logFile, "{}");

    await AUDIT.runAudit("m", "p");

    const tasksFile = path.join(TEST_DIR, "tasks.md");
    const tasksContent = fs.readFileSync(tasksFile, "utf8");
    assert(tasksContent.includes("[AUDIT] unit test task (from session unit-1)"));
    
    const updated = SESSIONS.loadSessions();
    assert(updated.completed[0].audited === true);
  });

  console.log(`\n=== Results ===`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  cleanup();
  if (failed > 0) process.exit(1);
}

runTests();
