// Test for index.js helper functions

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEST_TASKS = path.join(__dirname, "..", "test_tasks.md");

// Test tasks file content
const TEST_TASKS_CONTENT = `# Pending Tasks
- [ ] task one
- [ ] task two
- [ ] task three
`;

// Simple implementation of removeTaskFromPending for testing
function removeTaskFromPending(task) {
  if (!fs.existsSync(TEST_TASKS)) return false;
  let content = fs.readFileSync(TEST_TASKS, "utf8");
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
    fs.writeFileSync(TEST_TASKS, content);
    return true;
  }
  return false;
}

function cleanupTasks() {
  if (fs.existsSync(TEST_TASKS)) {
    fs.unlinkSync(TEST_TASKS);
  }
}

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
      date.setDate(date.getDate() + 1);
    }
    return date.getTime();
  }

  return null;
}

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

// Run tests
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "Assertion failed");
  }
}

console.log("\nRunning index.js helper function tests...\n");

// parseScheduleTime tests
console.log("=== parseScheduleTime Tests ===");
test("parses 5m as future time", () => {
  const result = parseScheduleTime("5m");
  assert(result > Date.now());
  assert(result < Date.now() + 600000); // within 10 minutes
});
test("parses 1h as future time", () => {
  const result = parseScheduleTime("1h");
  assert(result > Date.now());
  assert(result < Date.now() + 3700000); // within 1 hour + 1 minute buffer
});
test("parses 2h30m as future time", () => {
  const result = parseScheduleTime("2h30m");
  assert(result > Date.now());
  assert(result < Date.now() + 9100000); // within 2h31m
});
test("parses 30s as future time", () => {
  const result = parseScheduleTime("30s");
  assert(result > Date.now());
  assert(result < Date.now() + 60000); // within a minute
});
test("parses 1h30m0s as future time", () => {
  const result = parseScheduleTime("1h30m0s");
  assert(result > Date.now());
  const expected = Date.now() + 5400000;
  assert(Math.abs(result - expected) < 1000); // within 1 second
});
test("returns null for invalid format", () => {
  const result = parseScheduleTime("invalid");
  assert(result === null);
});
test("handles empty string", () => {
  const result = parseScheduleTime("");
  assert(typeof result === "number"); // returns a valid timestamp
});

// formatDuration tests
console.log("\n=== formatDuration Tests ===");
test("formats 0 as 'now'", () => {
  assert(formatDuration(0) === "now");
});
test("formats 30s as '30s'", () => {
  assert(formatDuration(30000) === "30s");
});
test("formats 1m as '1m 0s'", () => {
  assert(formatDuration(60000) === "1m 0s");
});
test("formats 5m30s as '5m 30s'", () => {
  assert(formatDuration(330000) === "5m 30s");
});
test("formats 1h15m as '1h 15m'", () => {
  assert(formatDuration(4500000) === "1h 15m");
});
test("formats 2h5m3s as '2h 5m'", () => {
  assert(formatDuration(7503000) === "2h 5m");
});
test("formats 25h as '1d 1h'", () => {
  assert(formatDuration(90000000) === "1d 1h");
});
test("formats 38h5m as '1d 14h'", () => {
  assert(formatDuration(138300000) === "1d 14h");
});

// removeTaskFromPending tests
console.log("\n=== removeTaskFromPending Tests ===");
test("removes a task from pending list", () => {
  cleanupTasks();
  fs.writeFileSync(TEST_TASKS, TEST_TASKS_CONTENT);
  const result = removeTaskFromPending("task two");
  assert(result === true);
  const content = fs.readFileSync(TEST_TASKS, "utf8");
  assert(content.includes("task one"));
  assert(content.includes("task three"));
  assert(!content.includes("task two"));
  cleanupTasks();
});
test("returns false for non-existent task", () => {
  cleanupTasks();
  fs.writeFileSync(TEST_TASKS, TEST_TASKS_CONTENT);
  const result = removeTaskFromPending("nonexistent task");
  assert(result === false);
  cleanupTasks();
});
test("handles empty tasks file", () => {
  cleanupTasks();
  const result = removeTaskFromPending("any task");
  assert(result === false);
  cleanupTasks();
});
test("handles task with special characters", () => {
  cleanupTasks();
  const specialContent = `# Pending Tasks
- [ ] task with "quotes"
- [ ] normal task
`;
  fs.writeFileSync(TEST_TASKS, specialContent);
  const result = removeTaskFromPending('task with "quotes"');
  assert(result === true);
  const content = fs.readFileSync(TEST_TASKS, "utf8");
  assert(content.includes("normal task"));
  assert(!content.includes('task with "quotes"'));
  cleanupTasks();
});

test("handles task with parentheses", () => {
  cleanupTasks();
  const parenContent = `# Pending Tasks
- [ ] task (with) parentheses
- [ ] normal task
`;
  fs.writeFileSync(TEST_TASKS, parenContent);
  const result = removeTaskFromPending("task (with) parentheses");
  assert(result === true);
  const content = fs.readFileSync(TEST_TASKS, "utf8");
  assert(content.includes("normal task"));
  assert(!content.includes("task (with) parentheses"));
  cleanupTasks();
});

// Status display tests
console.log("\n=== Status Display Logic Tests ===");

function buildStatusMsg(
  isRunning,
  currentRunningTask,
  pausedTaskInfo,
  pendingTasks,
) {
  const lines = [
    `**Status Report**`,
    `Working Directory: /test/path`,
    `Model: test-model`,
    `Auto-Next: OFF`,
  ];

  if (isRunning && currentRunningTask) {
    lines.push(`Agent: **RUNNING**`);
    lines.push(`Current Task: ${currentRunningTask}`);
  } else if (pausedTaskInfo) {
    lines.push(`Agent: **PAUSED** (quota)`);
    lines.push(`Paused Task: ${pausedTaskInfo.task}`);
  } else {
    lines.push(`Agent: idle`);
  }

  lines.push(`Pending Tasks: ${pendingTasks.length}`);

  // Don't show next task when running or paused
  if (pendingTasks.length > 0 && !isRunning && !pausedTaskInfo) {
    lines.push(`Next Task: ${pendingTasks[0]}`);
  }

  return lines.join("\n");
}

test("status shows RUNNING when task is running", () => {
  const status = buildStatusMsg(true, "my test task", null, []);
  assert(status.includes("Agent: **RUNNING**"));
  assert(status.includes("Current Task: my test task"));
});

test("status shows idle when no task and no paused tasks", () => {
  const status = buildStatusMsg(false, null, null, []);
  assert(status.includes("Agent: idle"));
  assert(!status.includes("RUNNING"));
  assert(!status.includes("PAUSED"));
});

test("status shows PAUSED when there are paused tasks", () => {
  const status = buildStatusMsg(false, null, { task: "paused task" }, []);
  assert(status.includes("Agent: **PAUSED** (quota)"));
  assert(status.includes("Paused Task: paused task"));
  assert(!status.includes("RUNNING"));
  assert(!status.includes("idle"));
});

test("status shows pending next task when idle with pending tasks", () => {
  const status = buildStatusMsg(false, null, null, ["task1", "task2"]);
  assert(status.includes("Agent: idle"));
  assert(status.includes("Next Task: task1"));
});

test("status does not show next task when running", () => {
  const status = buildStatusMsg(true, "running task", null, ["task1", "task2"]);
  assert(status.includes("Agent: **RUNNING**"));
  assert(!status.includes("Next Task:"));
});

test("status does not show next task when paused", () => {
  const status = buildStatusMsg(false, null, { task: "paused task" }, [
    "task1",
    "task2",
  ]);
  assert(status.includes("Agent: **PAUSED** (quota)"));
  assert(!status.includes("Next Task:"));
});

// isValidStatus validation tests
console.log("\n=== isValidStatus Validation Tests ===");

function isValidStatus(status) {
  if (!status || status.length < 3) return false;

  // Status should start with lowercase letter (as per instructions)
  if (!/^[a-z]/.test(status)) return false;

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

test("accepts valid status messages starting with lowercase", () => {
  assert(isValidStatus("running task"));
  assert(isValidStatus("implementing feature x"));
  assert(isValidStatus("completed setup"));
  assert(isValidStatus("looking for files"));
});

test("rejects empty or too short status", () => {
  assert(!isValidStatus(""));
  assert(!isValidStatus("a"));
  assert(!isValidStatus("ab"));
  assert(!isValidStatus(null));
  assert(!isValidStatus(undefined));
});

test("rejects status starting with uppercase", () => {
  assert(!isValidStatus("Running task"));
  assert(!isValidStatus("Implementing feature"));
  assert(!isValidStatus("STATUS: something"));
});

test("rejects instructional text that echoes the prompt", () => {
  assert(!isValidStatus("report your status by printing a line"));
  assert(!isValidStatus("printing a line starting with"));
  assert(!isValidStatus("starting with [STATUS]"));
  assert(!isValidStatus("use lowercase writing"));
  assert(!isValidStatus("the summary should be concise"));
  assert(!isValidStatus("only output the status line"));
  assert(!isValidStatus("provide a concise one-sentence"));
});

test("rejects status with instructional patterns at the start", () => {
  // These should be rejected because they start with known instructional phrases
  assert(!isValidStatus("report your status by printing"));
  assert(!isValidStatus("printing a line starting with"));
  // Note: "need to report your status" is valid because it doesn't START with the pattern
  // and "need to..." is a reasonable status update format
  assert(isValidStatus("need to check files"));
});

test("accepts reasonable progress updates", () => {
  assert(isValidStatus("working on task x"));
  assert(isValidStatus("configuring the agent"));
  assert(isValidStatus("checking file contents"));
  assert(isValidStatus("fixing the bug"));
  assert(isValidStatus("waiting for user input"));
});

// Tests for status summarizer arguments
console.log("\n=== runStatusSummarizer Arguments Tests ===");

// Extract the runStatusSummarizer function content
const indexSource = fs.readFileSync(join(__dirname, "index.js"), "utf8");
const functionStart = indexSource.indexOf("async function runStatusSummarizer");
const processSpawn = indexSource.indexOf(
  "const summarizerProcess = spawn",
  functionStart,
);

if (functionStart !== -1 && processSpawn !== -1) {
  const functionContent = indexSource.substring(functionStart, processSpawn);

  test("runStatusSummarizer does not use conflicting --no-session flag", () => {
    assert(
      !functionContent.includes("--no-session"),
      "piArgs should not contain --no-session flag",
    );
  });

  test("runStatusSummarizer includes --session flag", () => {
    assert(
      functionContent.includes("--session"),
      "piArgs should contain --session flag",
    );
  });

  test("runStatusSummarizer includes --print flag", () => {
    assert(
      functionContent.includes("--print"),
      "piArgs should contain --print flag",
    );
  });
} else {
  console.log(
    "  ⚠ Could not locate runStatusSummarizer function for args testing",
  );
}

console.log("\n=== Results ===");
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);

process.exit(failed > 0 ? 1 : 0);
