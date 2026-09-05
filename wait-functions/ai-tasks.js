/**
 * wait function: ai-tasks — wakes the MAIN dude agent when the task file
 * changes. caches the content hash of ai-tasks.md; fires when it differs
 * from the cached value. first run only stores the baseline (no fire).
 *
 * purpose: null  →  invokes the main dude agent (no --purpose flag)
 */
import fs from "fs";
import crypto from "crypto";

export const purpose = null;

export async function check({ state }) {
  const vaultDir = process.env.OBSIDIAN_DIR || `${process.env.HOME}/vault`;
  const tasksFile = process.env.DUDE_TASKS_FILE || `${vaultDir}/ai-tasks.md`;
  let content = null;
  try {
    content = fs.readFileSync(tasksFile, "utf8");
  } catch {
    return { fire: false, context: null, state: null };
  }
  const hash = crypto.createHash("sha256").update(content).digest("hex");

  // first run (no cached state): store baseline, don't fire
  if (state === null || state === undefined) {
    return { fire: false, context: null, state: hash };
  }
  if (state === hash) {
    return { fire: false, context: null, state: hash };
  }
  return {
    fire: true,
    context: `the task file ${tasksFile} changed since your last run — check it for new tasks or feedback.`,
    state: hash,
  };
}
