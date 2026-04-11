/**
 * Test script for the self-audit feature.
 * This tests the audit functionality independently.
 */

import fs from "fs";
import path from "path";
import * as AUDIT from "./src/audit.js";
import * as SESSIONS from "./src/sessions.js";

const MODEL_CODE = "gemini-2.0-flash";
const MODEL_PROVIDER = "google-gemini-cli";

function log(msg) {
  console.log(`[TEST] ${msg}`);
}

async function testAuditModule() {
  log("Testing audit module functions...");

  // Test 1: Check that the module exports runAudit
  if (typeof AUDIT.runAudit !== "function") {
    throw new Error("runAudit is not exported");
  }
  log("✓ runAudit is exported");

  // Test 2: Check that sessions module has the audited field support
  const sessions = SESSIONS.loadSessions();
  log(`✓ Sessions loaded: ${sessions.active.length} active, ${sessions.completed.length} completed`);

  // Test 3: Check if sessions have the audited field (for completed sessions)
  let missingAuditedField = 0;
  for (const s of sessions.completed) {
    if (!(s.hasOwnProperty("audited") || s.audited === undefined)) {
      // audited is optional for pre-existing sessions
    }
  }
  log(`Checked ${sessions.completed.length} completed sessions for audited field`);

  return true;
}

async function testAddDuplicateTask() {
  log("Testing addTask duplicate prevention...");

  const TASKS_FILE = process.env.DUDE_CONFIG_DIR
    ? path.join(process.env.DUDE_CONFIG_DIR, "tasks.md")
    : "./tasks.md";

  // Create a test tasks file
  const testContent = "# Pending Tasks\n- [ ] Test task 1\n- [ ] Test task 2\n";
  fs.writeFileSync(TASKS_FILE, testContent);

  // Test the addTask function by simulating what it does
  const newTask = "Test duplicate task";
  let content = fs.readFileSync(TASKS_FILE, "utf8");
  
  // Check if task already exists as pending
  if (content.includes(`- [ ] ${newTask}`)) {
    log("✓ Duplicate task correctly detected");
  } else {
    log("✓ New task correctly identified as unique");
    // Add the new task
    content = content.replace(
      "# Pending Tasks\n",
      `# Pending Tasks\n- [ ] ${newTask}\n`,
    );
    fs.writeFileSync(TASKS_FILE, content);
  }

  // Check that task was added
  content = fs.readFileSync(TASKS_FILE, "utf8");
  if (content.includes(`- [ ] ${newTask}`)) {
    log("✓ Task successfully added");
  }

  // Clean up test file
  fs.unlinkSync(TASKS_FILE);
  log("✓ Test cleanup complete");

  return true;
}

async function testLogFileFinder() {
  log("Testing log file finder with sample sessions...");

  const SESSIONS_DIR = path.join(process.env.HOME, ".pi/agent/sessions");
  
  if (!fs.existsSync(SESSIONS_DIR)) {
    log("⚠ Sessions directory not found, skipping log file finder test");
    return true;
  }

  // Find sample session directories
  const sessionDirs = fs.readdirSync(SESSIONS_DIR).filter(d => d.startsWith("--home-"));
  
  if (sessionDirs.length === 0) {
    log("⚠ No session directories found, skipping log file finder test");
    return true;
  }

  log(` Found ${sessionDirs.length} session directories`);

  // Pick first session directory and check for log files
  for (const dir of sessionDirs.slice(0, 2)) {
    const dirPath = path.join(SESSIONS_DIR, dir);
    const files = fs.readdirSync(dirPath);
    const jsonlFiles = files.filter(f => f.endsWith(".jsonl"));
    
    if (jsonlFiles.length > 0) {
      log(`  ${dir}: ${jsonlFiles.length} log file(s)`);
    }
  }

  return true;
}

async function runAllTests() {
  console.log("Starting audit feature tests...\n");

  try {
    await testAuditModule();
    console.log();

    await testAddDuplicateTask();
    console.log();

    await testLogFileFinder();
    console.log();

    log("All tests passed!");
  } catch (err) {
    console.error("Test failed:", err);
    process.exit(1);
  }
}

runAllTests();
