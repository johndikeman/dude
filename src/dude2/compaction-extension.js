/**
 * dude2 compaction (phase 3) — enable and tune auto-compaction for the
 * dude2 runtime's primary model (glm-5.3) and inject dude2-specific
 * compaction instructions so open-task state and victory conditions
 * survive summarization.
 *
 * two halves:
 *  1. settings: pi reads compaction config from <project-dir>/.pi/settings
 *     .json — dude2-run writes it into the run's workspace from env-tuned
 *     cfg values (writeCompactionSettings, pure + fs-injectable).
 *  2. instructions: this pi extension appends a dude2 instruction block to
 *     every compaction's custom instructions (session_before_compact),
 *     so summaries keep: current objective, pipeline stage state, victory
 *     conditions, pending john escalations.
 *
 * loaded into every dude2 run via ADDITIONAL_EXTENSION_PATHS (DUDE2_RUN_ID).
 */

import fs from "fs";

/** build the .pi/settings.json compaction block for a run workspace. */
export function compactionSettings(cfg) {
  return {
    compaction: {
      enabled: cfg.compactionEnabled !== false,
      reserveTokens: cfg.compactionReserveTokens ?? 24_000,
      keepRecentTokens: cfg.compactionKeepRecentTokens ?? 32_000,
    },
  };
}

/** write <workspace>/.pi/settings.json (merge, don't clobber other keys). */
export function writeCompactionSettings(cfg, workspace, fsMod = fs) {
  const dir = `${workspace}/.pi`.replace(/\/+$/, "");
  const file = `${dir}/settings.json`;
  let existing = {};
  try {
    existing = JSON.parse(fsMod.readFileSync(file, "utf8")) ?? {};
  } catch {
    /* no file yet */
  }
  fsMod.mkdirSync(dir, { recursive: true });
  fsMod.writeFileSync(file, JSON.stringify({ ...existing, ...compactionSettings(cfg) }, null, 2));
  return file;
}

/** the instruction block appended to every compaction summary request. */
export const COMPACTION_INSTRUCTIONS = `
when summarizing, you MUST preserve verbatim:
1. the run's objective / acceptance criteria as stated in the first user message
2. any pipeline stage state (e.g. "stage: implement (ready)" lines) and project doc paths
3. victory conditions and any callbacks the run still owes (discord, dispatcher)
4. pending john escalations / sign-off requests with their discord message ids
keep tool-result details lossy, but never drop the state machine.
`.trim();

export default function register(pi) {
  if (!process.env.DUDE2_RUN_ID) return;
  pi.on("session_before_compact", async (event) => {
    // append dude2 instructions to this compaction's instruction set (in
    // place — pi's custom-instructions handling keeps the event object)
    const prev = typeof event.customInstructions === "string" ? event.customInstructions : "";
    event.customInstructions = (prev ? prev + "\n\n" : "") + COMPACTION_INSTRUCTIONS;
  });
}
