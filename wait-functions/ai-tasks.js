/**
 * wait function: ai-tasks — wakes the MAIN dude agent when the task file
 * changes. hashes ONLY the checklist lines (`- [ ]` / `- [x]`), so prose
 * edits (doc rewording, agent log appends, formatting) don't fire the
 * agent — only actual task-list changes do. first run stores the baseline
 * (no fire).
 *
 * purpose: null  →  invokes the main dude agent (no --purpose flag)
 */
import fs from "fs";
import crypto from "crypto";

export const purpose = null;

function checklistHash(content) {
  const lines = content.split("\n").filter((l) => /^\s*- \[[ xX]\]/.test(l));
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}

export async function check({ state }) {
  const vaultDir = process.env.OBSIDIAN_DIR || `${process.env.HOME}/vault`;
  const tasksFile = process.env.DUDE_TASKS_FILE || `${vaultDir}/ai-tasks.md`;
  let content = null;
  try {
    content = fs.readFileSync(tasksFile, "utf8");
  } catch {
    return { fire: false, context: null, state: null };
  }
  const hash = checklistHash(content);

  // first run (no cached state): store baseline, don't fire
  if (state === null || state === undefined) {
    return { fire: false, context: null, state: hash };
  }
  if (state === hash) {
    return { fire: false, context: null, state: hash };
  }
  // expanded context: include the current checklist so the agent sees the
  // task state at a glance without re-reading
  const checklist = content.split("\n").filter((l) => /^\s*- \[[ xX]\]/.test(l)).join("\n");
  return {
    fire: true,
    context: {
      summary: `the task file ${tasksFile} changed since your last run — check it for new tasks or feedback.`,
      currentChecklist: checklist,
    },
    state: hash,
  };
}
