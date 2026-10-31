/**
 * tasks-wait-state — keep wait-state.json's `ai-tasks` hash in sync after
 * the agent edits the task file itself.
 *
 * problem: wait-functions/ai-tasks.js fires the agent whenever the task
 * file's checklist changes. when the agent edits ai-tasks.md during a run
 * (checking a task off, etc.), that same edit would wake the agent again on
 * the next wait tick — a self-trigger cascade. the wait runner already
 * re-baselines after a run completes, but between the self-edit and the
 * re-baseline (or if the run dies uncleanly), any tick sees a "new" hash
 * and re-fires.
 *
 * fix: the tasks-wait-state-sync pi extension hooks tool_execution_end for
 * edit/write calls whose target is the task file and immediately updates
 * the stored hash. that closes the race window and also fixes the
 * unclean-exit case where the runner's refresh never happens.
 *
 * the update only fires for the agent's own tool-mediated edits — human
 * edits to the file still fire the wait function as intended.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

// self-contained copy of wait-runner.js's defaultStateFile — the installed
// extension lives outside the dude package, so relative imports into the
// repo can't resolve there.
function defaultStateFile() {
  return process.env.DUDE_WAIT_STATE_FILE ||
    path.join(
      process.env.DUDE_CONFIG_DIR || path.join(process.env.HOME || "/tmp", ".config/dude"),
      "wait-state.json",
    );
}

// self-contained copy of wait-functions/ai-tasks.js's defaultTasksFile
function defaultTasksFile() {
  const vaultDir = process.env.OBSIDIAN_DIR || `${process.env.HOME}/vault`;
  return process.env.DUDE_TASKS_FILE || `${vaultDir}/ai-tasks.md`;
}

// self-contained copy of ai-tasks.js's checklistHash
function checklistHash(content) {
  const lines = content.split("\n").filter((l) => /^\s*- \[[ xX]\]/.test(l));
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** absolute path of the task file (env-overridable, same lookup as the wait fn) */
export function tasksFile() {
  return path.resolve(defaultTasksFile());
}

/**
 * recompute the checklist hash of the task file and write it into the
 * `ai-tasks` entry of wait-state.json. returns { updated, hash, stateFile }
 * — updated is false if the task file is missing/unreadable (nothing to
 * sync; the wait fn handles that itself on its next check).
 */
export function syncTasksWaitState({ tasksFile: file = tasksFile(), stateFile = defaultStateFile() } = {}) {
  let hash;
  try {
    hash = checklistHash(fs.readFileSync(file, "utf8"));
  } catch {
    return { updated: false, hash: null, stateFile };
  }
  return { updated: true, hash, ...writeTasksHash(hash, stateFile) };
}

/** write a hash into the ai-tasks slot of wait-state.json, preserving other keys */
export function writeTasksHash(hash, stateFile = defaultStateFile()) {
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    /* missing/corrupt state file: start fresh, preserving nothing */
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) state = {};
  state["ai-tasks"] = hash;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  try {
    fs.renameSync(tmp, stateFile);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* renamed ok */ }
  }
  return { stateFile };
}

// this file is both a library (imported by tasks-wait-state-sync.ts) and
// installed into pi's extensions dir, where pi tries to load every file as
// an extension. export a no-op factory so the extension load is a no-op
// (the real hooking happens in tasks-wait-state-sync.ts).
export default function () { /* no-op: helper module, see tasks-wait-state-sync.ts */ }
