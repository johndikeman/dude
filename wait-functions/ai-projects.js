/**
 * wait function: ai-projects — wakes the ENGINEERING ORCHESTRATOR when the
 * project index file changes. mirrors wait-functions/ai-tasks.js exactly,
 * but watches `~/vault/ai-projects.md` (larger engineering projects run
 * through the staged engineering-task pipeline instead of the one-shot
 * ai-tasks checklist) and invokes the `eng-orchestrator` purpose.
 *
 * hashes ONLY the checklist lines (`- [ ]` / `- [x]`), so prose edits
 * (doc appends, log noise, formatting) don't fire — only actual
 * project-list changes do. first run stores the baseline (no fire).
 *
 * purpose: `eng-orchestrator`  →  `dude-agent --once --purpose eng-orchestrator`
 */
import fs from "fs";
import crypto from "crypto";

export const purpose = "eng-orchestrator";

export function defaultProjectsFile() {
  const vaultDir = process.env.OBSIDIAN_DIR || `${process.env.HOME}/vault`;
  return process.env.DUDE_PROJECTS_FILE || `${vaultDir}/ai-projects.md`;
}

/** sha256 over just the checklist lines — the value stored in wait-state.json */
export function checklistHash(content) {
  const lines = content.split("\n").filter((l) => /^\s*- \[[ xX]\]/.test(l));
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}

export async function check({ state }) {
  const projectsFile = defaultProjectsFile();
  let content = null;
  try {
    content = fs.readFileSync(projectsFile, "utf8");
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
  const checklist = content.split("\n").filter((l) => /^\s*- \[[ xX]\]/.test(l)).join("\n");
  return {
    fire: true,
    context: {
      summary: `the project file ${projectsFile} changed since the last orchestrator run — check it for new projects or feedback.`,
      currentChecklist: checklist,
    },
    state: hash,
  };
}
