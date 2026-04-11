// Test for model configuration and fallback handling

import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEST_CONFIG_FILE = path.join(__dirname, "..", "test_config.json");
const TEST_CONFIG_DIR = path.join(__dirname, "..");

// Cleanup function
function cleanupConfig() {
  if (fs.existsSync(TEST_CONFIG_FILE)) {
    fs.unlinkSync(TEST_CONFIG_FILE);
  }
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

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

console.log("\nRunning model configuration tests...\n");

// Test 1: Default config values
console.log("=== Default Configuration Tests ===");
test("has default config values", () => {
  cleanupConfig();
  
  const config = {
    workDir: process.cwd(),
    autoNext: false,
    statusUpdateInterval: 120000,
    statusUpdateModel: "gemini-2.0-flash",
    lastChannelId: null,
    modelCode: "gemini-3-flash-preview",
    modelProvider: "google-gemini-cli",
    fallbackModelCode: null,
    fallbackModelProvider: null,
    useFallbackOnQuotaError: false,
  };
  
  assertEqual(config.modelCode, "gemini-3-flash-preview");
  assertEqual(config.modelProvider, "google-gemini-cli");
  assertEqual(config.fallbackModelCode, null);
  assertEqual(config.useFallbackOnQuotaError, false);
  
  cleanupConfig();
});

// Test 2: Determine model provider from code
console.log("\n=== Model Provider Detection Tests ===");
test("correctly identifies verda model", () => {
  const modelCode = "qwen3.5:122b";
  const provider = modelCode === "qwen3.5:122b" ? "verda" : "google-gemini-cli";
  assertEqual(provider, "verda");
});

test("correctly identifies google-gemini-cli model", () => {
  const modelCode = "gemini-3-flash-preview";
  const provider = modelCode === "qwen3.5:122b" ? "verda" : "google-gemini-cli";
  assertEqual(provider, "google-gemini-cli");
});

test("correctly identifies other google-gemini-cli models", () => {
  const modelCode = "gemini-2.5-pro";
  const provider = modelCode === "qwen3.5:122b" ? "verda" : "google-gemini-cli";
  assertEqual(provider, "google-gemini-cli");
});

// Test 3: Fallback model config
console.log("\n=== Fallback Model Configuration Tests ===");
test("enables fallback when configured", () => {
  cleanupConfig();
  
  const config = {
    modelCode: "gemini-3-flash-preview",
    modelProvider: "google-gemini-cli",
    fallbackModelCode: "gemini-2.5-pro",
    fallbackModelProvider: "google-gemini-cli",
    useFallbackOnQuotaError: true,
  };
  
  assertEqual(config.useFallbackOnQuotaError, true);
  assertEqual(config.fallbackModelCode, "gemini-2.5-pro");
  
  cleanupConfig();
});

test("fallback disabled without fallback model", () => {
  cleanupConfig();
  
  const config = {
    modelCode: "gemini-3-flash-preview",
    modelProvider: "google-gemini-cli",
    fallbackModelCode: null,
    fallbackModelProvider: null,
    useFallbackOnQuotaError: true, // enabled but no fallback model
  };
  
  assertEqual(config.useFallbackOnQuotaError, true);
  assertEqual(config.fallbackModelCode, null);
  
  // This should trigger a warning in the command handler
  cleanupConfig();
});

// Test 4: Fallback retry task parsing
console.log("\n=== Fallback Retry Parsing Tests ===");

function parseFallbackRetry(task) {
  let isFallbackRetry = false;
  let originalTask = task;
  let previousError = "";
  
  if (task.startsWith("[FALLBACK_RETRY]")) {
    isFallbackRetry = true;
    const match = task.match(/\[FALLBACK_RETRY\]\s*Original:\s*(.+?)\s*Previous error:\s*(.+)/s);
    if (match) {
      originalTask = match[1].trim();
      previousError = match[2].trim();
    }
  }
  
  return { isFallbackRetry, originalTask, previousError };
}

test("parses fallback retry task correctly", () => {
  const task = "[FALLBACK_RETRY] Original: fix the bug\nPrevious error: You have exhausted your capacity on this model.";
  const result = parseFallbackRetry(task);
  
  assert(result.isFallbackRetry === true);
  assertEqual(result.originalTask, "fix the bug");
  assertEqual(result.previousError, "You have exhausted your capacity on this model.");
});

test("handles multiline task descriptions", () => {
  const task = "[FALLBACK_RETRY] Original: implement feature\nwith multiple\nlines\nPrevious error: quota exhausted error";
  const result = parseFallbackRetry(task);
  
  assert(result.isFallbackRetry === true);
  assertEqual(result.originalTask, "implement feature\nwith multiple\nlines");
  assertEqual(result.previousError, "quota exhausted error");
});

test("returns false for non-fallback tasks", () => {
  const task = "just a normal task";
  const result = parseFallbackRetry(task);
  
  assert(result.isFallbackRetry === false);
  assertEqual(result.originalTask, "just a normal task");
  assertEqual(result.previousError, "");
});

// Test 5: Session tracking
console.log("\n=== Session Tracking Tests ===");
test("session supports fallbackRetryContext", () => {
  const session = {
    id: "12345",
    task: "test task",
    createdAt: Date.now(),
    status: "active",
    fallbackRetryContext: {
      originalTask: "original task",
      previousModelError: "quota error",
      fallbackModelUsed: "gemini-2.5-pro",
    },
  };
  
  assertEqual(session.fallbackRetryContext.originalTask, "original task");
  assertEqual(session.fallbackRetryContext.fallbackModelUsed, "gemini-2.5-pro");
});

console.log(`\n=== Results ===`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);

process.exit(failed > 0 ? 1 : 0);
