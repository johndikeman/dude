/**
 * tests for the agent prompt builder (src/agent-prompt.js)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildAgentPrompt } from "./src/agent-prompt.js";

const PATHS = {
  tasksFile: "/vault/ai-tasks.md",
  workingDir: "/home/dude-workspace",
  piSessionDir: "/home/.config/dude/sessions",
};
const NOW = new Date("2026-09-06T13:00:00Z");

const fullFor = (opts = {}) =>
  buildAgentPrompt({ paths: PATHS, now: NOW, ...opts });

test("full prompt contains task-processing instructions and no purpose section by default", () => {
  const p = fullFor();
  assert.ok(p.includes(`implement the tasks/goals laid out for you in ${PATHS.tasksFile}`));
  assert.ok(p.includes(`mark it as done in the task file (${PATHS.tasksFile})`));
  assert.ok(p.includes(`previous session logs can be found in ${PATHS.piSessionDir}`));
  assert.ok(p.includes("Current working directory: /home/dude-workspace"));
  assert.ok(!p.includes("## purpose:"));
  assert.ok(p.includes(NOW.toLocaleString("en-US")));
});

test("purpose without trimBasePrompt keeps the full prompt and appends the purpose block", () => {
  const purpose = { name: "demo", prompt: "do the demo thing" };
  const p = fullFor({ purpose });
  assert.ok(p.includes("implement the tasks/goals laid out for you"));
  assert.ok(p.includes("## purpose: demo"));
  assert.ok(p.includes("do the demo thing"));
});

test("wait-runner context is appended when given", () => {
  const p = fullFor({ context: "file changed at 13:00" });
  assert.ok(p.includes("## wait-runner context (why you were invoked now)"));
  assert.ok(p.includes("file changed at 13:00"));
});

test("discord one-off message is appended when given", () => {
  const p = fullFor({ message: { content: "hello dude" } });
  assert.ok(p.includes("you're being invoked as a one-off through discord"));
  assert.ok(p.includes("hello dude"));
});

test("trimBasePrompt: purpose run drops task-processing boilerplate entirely", () => {
  const purpose = {
    name: "demo",
    prompt: "do the demo thing",
    trimBasePrompt: true,
  };
  const p = fullFor({ purpose });
  // purpose + context still there
  assert.ok(p.includes("## purpose: demo"));
  assert.ok(p.includes("do the demo thing"));
  // task triage / logging instructions gone
  assert.ok(!p.includes("implement the tasks/goals laid out for you"));
  assert.ok(!p.includes("mark it as done in the task file"));
  assert.ok(!p.includes("open a PR using gh cli"));
  assert.ok(!p.includes("previous session logs can be found in"));
  assert.ok(!p.includes("- Task File:"));
  // identity + environment + tone still there
  assert.ok(p.includes('You are dude, a coding agent'));
  assert.ok(p.includes(`your workspace is in (${PATHS.workingDir})`));
  assert.ok(p.includes("onepassword service account"));
  assert.ok(p.includes("use lowercase writing and a semi-informal tone."));
});

test("trimBasePrompt: run is told not to log to the task file but keeps an escalation path", () => {
  const purpose = { name: "demo", prompt: "do the demo thing", trimBasePrompt: true };
  const p = fullFor({ purpose });
  assert.ok(p.includes(`do NOT process the task file (${PATHS.tasksFile})`));
  assert.ok(p.includes("no log entries, no task marking"));
  // escalation exception documented
  assert.ok(p.includes("append a short note to the task file"));
});

test("trimBasePrompt: wait-runner context still lands in the trimmed prompt", () => {
  const purpose = { name: "demo", prompt: "do the demo thing", trimBasePrompt: true };
  const p = fullFor({ purpose, context: "fired because x" });
  assert.ok(p.includes("## wait-runner context (why you were invoked now)"));
  assert.ok(p.includes("fired because x"));
});
