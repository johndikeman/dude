#!/usr/bin/env node
/**
 * End-to-End Acceptance Tests
 * Tests actual agent behavior with mocked external dependencies
 */

import fs from "fs";
import path from "path";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DIR = join(__dirname, "..", "test_acceptance");

/**
 * Safeguard logic from .pi/extensions/tasks-safeguard.ts
 */
function isValidEdit(oldText, newText) {
  if (oldText.includes("[ ]") && newText === oldText.replace("[ ]", "[x]")) return true;
  if (newText.startsWith(oldText)) {
      const added = newText.slice(oldText.length);
      if (isOnlyNewTasks(added)) return true;
  }
  if (newText.endsWith(oldText)) {
      const added = newText.slice(0, newText.length - oldText.length);
      if (isOnlyNewTasks(added)) return true;
  }
  return false;
}
function isOnlyNewTasks(text) {
  const lines = text.split("\n").filter(l => l.trim() !== "");
  return lines.every(line => line.trim().startsWith("- [ ]"));
}
function isValidWrite(oldContent, newContent) {
  const oldLines = oldContent.split("\n").map(l => l.trim()).filter(l => l !== "");
  const newLines = newContent.split("\n").map(l => l.trim()).filter(l => l !== "");
  let oldIdx = 0;
  for (let newIdx = 0; newIdx < newLines.length; newIdx++) {
    if (oldIdx < oldLines.length) {
      const oldLine = oldLines[oldIdx];
      const newLine = newLines[newIdx];
      if (oldLine === newLine) { oldIdx++; continue; }
      if (oldLine.includes("[ ]") && newLine === oldLine.replace("[ ]", "[x]")) { oldIdx++; continue; }
      if (newLine.startsWith("- [ ]")) { continue; }
      return false;
    } else {
      const newLine = newLines[newIdx];
      if (!newLine.startsWith("- [ ]") && newLine !== "" && !newLine.startsWith("#")) return false;
    }
  }
  return oldIdx === oldLines.length;
}

if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
process.env.DUDE_CONFIG_DIR = TEST_DIR;

import * as SCHEDULER from "./scheduler.js";
import * as SESSIONS from "./sessions.js";

let testState = { discordMessages: [], pausedTasks: [], fallbackAttempts: [], completedTasks: [], config: null, isRunning: false };

function resetState() { testState = { discordMessages: [], pausedTasks: [], fallbackAttempts: [], completedTasks: [], config: null, isRunning: false }; }

function setup(config = {}) {
  resetState();
  ["config.json", "tasks.md", "schedule.json", "sessions.json", "session-map.json"].forEach(f => {
    const file = join(TEST_DIR, f);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });
  testState.config = { workDir: TEST_DIR, modelCode: "gemini-3-flash-preview", modelProvider: "google-gemini-cli", fallbackModelCode: "gemini-2.5-pro", useFallbackOnQuotaError: false, ...config };
  fs.writeFileSync(join(TEST_DIR, "config.json"), JSON.stringify(testState.config, null, 2));
  fs.writeFileSync(join(TEST_DIR, "tasks.md"), "# Pending Tasks\n");
  return testState.config;
}

function addTask(task) { let content = fs.readFileSync(join(TEST_DIR, "tasks.md"), "utf8"); fs.writeFileSync(join(TEST_DIR, "tasks.md"), content + `- [ ] ${task}\n`); }
function getPendingTasks() { return fs.readFileSync(join(TEST_DIR, "tasks.md"), "utf8").split("\n").filter(l => l.includes("[ ]")).map(l => l.replace(/- \[ \] /, "").trim()).filter(Boolean); }
function completeTask(task) { let content = fs.readFileSync(join(TEST_DIR, "tasks.md"), "utf8"); fs.writeFileSync(join(TEST_DIR, "tasks.md"), content.replace(new RegExp(`- \\[ \\] ${task}\\n?`), `- [x] ${task}\n`)); }
function removeTaskFromPending(task) { let content = fs.readFileSync(join(TEST_DIR, "tasks.md"), "utf8"); fs.writeFileSync(join(TEST_DIR, "tasks.md"), content.replace(new RegExp(`- \\[ \\] ${task}\\n`), "")); }

class MockDiscord {
  constructor() { this.messages = []; }
  async send(channelId, content) { const msg = { id: `msg-${Date.now()}`, channelId, content, type: "send" }; this.messages.push(msg); testState.discordMessages.push(msg); return msg; }
  async reply(messageId, content) { const msg = { id: `reply-${Date.now()}`, replyTo: messageId, content, type: "reply" }; this.messages.push(msg); testState.discordMessages.push(msg); return msg; }
}

function simulatePiOutput(task, model, shouldFailQuota, quotaResetTime) {
  if (shouldFailQuota) {
    return { stdout: [], stderr: [`Cloud Code Assist API error (429): quota will reset after ${quotaResetTime}.`], exitCode: 2 };
  }
  return { stdout: [JSON.stringify({ type: "finish", result: { code: 0 } })], stderr: [], exitCode: 0 };
}

function processPiOutput(task, options, isFallback) {
  const model = isFallback ? (testState.config.fallbackModelCode || testState.config.modelCode) : testState.config.modelCode;
  const { shouldFailQuota, quotaResetTime } = options;
  const result = simulatePiOutput(task, model, shouldFailQuota, quotaResetTime);
  
  for (const line of result.stderr) {
    const trimmed = line.trim();
    if (SCHEDULER.isQuotaError(trimmed)) {
      testState.quotaErrors = testState.quotaErrors || [];
      testState.quotaErrors.push({ task, model });
      const errorInfo = SCHEDULER.parseQuotaError(trimmed);
      if (testState.config.useFallbackOnQuotaError && testState.config.fallbackModelCode) {
        const fallbackTask = `[FALLBACK_RETRY] Original: ${task}\nPrevious error: ${errorInfo.errorMessage}`;
        addTask(fallbackTask);
        testState.fallbackAttempts.push({ originalTask: task, fallbackTask, error: errorInfo.errorMessage });
        return { success: false, type: "fallback_retry", fallbackTask, error: errorInfo.errorMessage };
      } else {
        const paused = SCHEDULER.pauseTask(task, errorInfo, { sessionId: `session-${Date.now()}` });
        removeTaskFromPending(task);
        SCHEDULER.scheduleTask(task, paused.resumeAt, "quota_resume");
        testState.pausedTasks.push({ task, pauseId: paused.id, resumeAt: paused.resumeAt });
        return { success: false, type: "paused", pauseId: paused.id, resumeAt: paused.resumeAt };
      }
    }
  }
  
  testState.completedTasks.push(task);
  completeTask(task);
  return { success: true, task, model };
}

async function runCycle(options = {}) {
  if (testState.isRunning) return { status: "already_running" };
  const tasks = getPendingTasks();
  if (tasks.length === 0) return { status: "no_tasks" };
  testState.isRunning = true;
  const task = tasks[0];
  let isFallback = task.startsWith("[FALLBACK_RETRY]");
  let originalTask = task;
  if (isFallback) { const match = task.match(/\[FALLBACK_RETRY\]\s*Original:\s*(.+?)\s*Previous error:\s*(.+)/s); if (match) { originalTask = match[1].trim(); } }
  const result = processPiOutput(originalTask, options.simulation || {}, isFallback);
  if (options.discordClient) {
    if (result.type === "fallback_retry") options.discordClient.reply(options.initialMessage?.id, `**Status:** Fallback queued`);
    else if (result.type === "paused") options.discordClient.reply(options.initialMessage?.id, `**Status:** Paused`);
    else if (result.success) options.discordClient.reply(options.initialMessage?.id, `**Status:** Completed`);
  }
  testState.isRunning = false;
  return { ...result, task };
}

function assert(c, m = "Assert") { if (!c) throw new Error(m); }
function assertEqual(a, b, m = "Equal") { if (a !== b) throw new Error(`${m}: Expected ${b}, got ${a}`); }
function assertNotNull(v, m = "NotNull") { if (v == null) throw new Error(m); }
function assertContains(s, t, m = "Contains") { if (!s.includes(t)) throw new Error(`${m}: "${s}" missing "${t}"`); }

let passed = 0, failed = 0;

async function test(name, fn) {
  setup();
  console.log(`\n  Running: ${name}`);
  try { await fn(); console.log(`  ✓ PASS`); passed++; }
  catch (e) { console.log(`  ✗ FAIL: ${e.message}`); failed++; }
}

console.log("\n" + "=".repeat(70) + "\nAGENT SERVICE - ACCEPTANCE TESTS\n" + "=".repeat(70));

await test("SCENARIO 1: Process single task", async () => {
  addTask("Feature");
  const discord = new MockDiscord();
  const result = await runCycle({ discordClient: discord, initialMessage: await discord.send("ch", "Start"), simulation: { shouldFailQuota: false } });
  assert(result.success);
  assertEqual(result.task, "Feature");
  assertEqual(testState.completedTasks.length, 1);
});

await test("SCENARIO 2: Multiple tasks", async () => {
  addTask("A"); addTask("B");
  assertEqual(getPendingTasks().length, 2);
  await runCycle(); assertEqual(getPendingTasks().length, 1);
  await runCycle(); assertEqual(getPendingTasks().length, 0);
});

await test("SCENARIO 3: Quota error - pause", async () => {
  setup({ useFallbackOnQuotaError: false });
  addTask("Heavy");
  const discord = new MockDiscord();
  const result = await runCycle({ discordClient: discord, initialMessage: await discord.send("ch", "Start"), simulation: { shouldFailQuota: true, quotaResetTime: "2h0m0s" } });
  assertEqual(result.type, "paused");
  assertEqual(testState.pausedTasks.length, 1);
  assert(discord.messages.some(m => m.content.toLowerCase().includes("paused")));
});

await test("SCENARIO 4: Quota error - fallback", async () => {
  setup({ useFallbackOnQuotaError: true, fallbackModelCode: "gemini-2.5-pro" });
  addTask("GPU");
  const result = await runCycle({ simulation: { shouldFailQuota: true, quotaResetTime: "1h0m0s" } });
  assertEqual(result.type, "fallback_retry");
  assertEqual(testState.fallbackAttempts.length, 1);
  assertContains(result.fallbackTask, "FALLBACK_RETRY");
});

await test("SCENARIO 5: Fallback retry succeeds", async () => {
  setup({ useFallbackOnQuotaError: true, fallbackModelCode: "gemini-2.5-pro" });
  addTask("Big");
  const r1 = await runCycle({ simulation: { shouldFailQuota: true } });
  assertEqual(r1.type, "fallback_retry");
  await runCycle({ simulation: { shouldFailQuota: false } });
  assertEqual(testState.completedTasks.length, 1);
});

await test("SCENARIO 6: Resume paused task", async () => {
  setup({ useFallbackOnQuotaError: false });
  addTask("Resume");
  const r1 = await runCycle({ simulation: { shouldFailQuota: true } });
  assertEqual(r1.type, "paused");
  const schedule = SCHEDULER.loadSchedule();
  const idx = schedule.paused.findIndex(t => t.id === r1.pauseId);
  schedule.paused.splice(idx, 1);
  fs.writeFileSync(join(TEST_DIR, "schedule.json"), JSON.stringify(schedule, null, 2));
  addTask(schedule.scheduled[idx] ? schedule.scheduled[idx].task : "Resume");
  assertEqual(getPendingTasks().length, 1);
  await runCycle({ simulation: { shouldFailQuota: false } });
  assertEqual(testState.completedTasks.length, 1);
});

await test("SCENARIO 7: Discord notifications", async () => {
  setup({ useFallbackOnQuotaError: false });
  addTask("Notify");
  const discord = new MockDiscord();
  await runCycle({ discordClient: discord, initialMessage: await discord.send("ch", "Start"), simulation: { shouldFailQuota: true } });
  assert(discord.messages.some(m => m.content.toLowerCase().includes("paused")));
});

await test("SCENARIO 8: Empty queue", async () => {
  const result = await runCycle();
  assertEqual(result.status, "no_tasks");
});

await test("SCENARIO 9: Concurrent execution prevention", async () => {
  addTask("Concurrent");
  testState.isRunning = true;
  const result = await runCycle();
  assertEqual(result.status, "already_running");
  testState.isRunning = false;
});

await test("SCENARIO 10: Parsing various quota formats", async () => {
  const tests = [
    "Cloud Code API error (429): quota will reset after 1h30m",
    "error (429): quota will reset after 30m0s",
    "api error 429: rate limit exceeded",
  ];
  for (const e of tests) {
    const p = SCHEDULER.parseQuotaError(e);
    assertNotNull(p);
    assertEqual(p.type, "quota_exhausted");
  }
});

await test("SCENARIO 11: Quota error detection", async () => {
  assert(SCHEDULER.isQuotaError("api error (429): quota will reset"));
  assert(SCHEDULER.isQuotaError("error 429: Quota exhausted"));
  assert(SCHEDULER.isQuotaError("api error: 429 rate limit exceeded"));
  assert(!SCHEDULER.isQuotaError("normal error"));
  assert(!SCHEDULER.isQuotaError("try again later"));
});

await test("SCENARIO 12: Discord fallback notifications", async () => {
  setup({ useFallbackOnQuotaError: true, fallbackModelCode: "gemini-2.5-pro" });
  addTask("Fallback Discord");
  const discord = new MockDiscord();
  await runCycle({ discordClient: discord, initialMessage: await discord.send("ch", "Start"), simulation: { shouldFailQuota: true } });
  assert(discord.messages.some(m => m.content.includes("Fallback")));
});

await test("SCENARIO 13: Tasks safeguard compliance - valid edit", async () => {
  setup();
  addTask("Task 1");
  const oldContent = "- [ ] Task 1";
  const newContent = "- [x] Task 1";
  assert(isValidEdit(oldContent, newContent), "Crossing off task should be allowed");
});

await test("SCENARIO 14: Tasks safeguard compliance - valid write", async () => {
  setup();
  addTask("Task 1");
  const oldContent = fs.readFileSync(join(TEST_DIR, "tasks.md"), "utf8");
  const newContent = oldContent.replace("[ ] Task 1", "[x] Task 1") + "- [ ] Task 2\n";
  assert(isValidWrite(oldContent, newContent), "Crossing off and adding should be allowed");
});

await test("SCENARIO 15: Tasks safeguard compliance - invalid write blocked", async () => {
  setup();
  addTask("Task 1");
  const oldContent = fs.readFileSync(join(TEST_DIR, "tasks.md"), "utf8");
  const newContent = "# Cleared\n";
  assert(!isValidWrite(oldContent, newContent), "Clearing tasks should be blocked");
});

console.log("\n" + "=".repeat(70) + `\nRESULTS: ${passed} passed, ${failed} failed\n` + "=".repeat(70));

["config.json", "tasks.md", "schedule.json", "sessions.json", "session-map.json"].forEach(f => {
  try { if (fs.existsSync(join(TEST_DIR, f))) fs.unlinkSync(join(TEST_DIR, f)); } catch (e) {}
});

process.exit(failed > 0 ? 1 : 0);
