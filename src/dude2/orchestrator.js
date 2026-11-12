/**
 * dude2 eng-orchestrator revamp (phase 6).
 *
 * the orchestrator is no longer a systemd-coupled supervisor: it is an
 * ordinary dude2 agent run that spawns stage runs as ISOLATED sub-agents
 * via the `spawn_run` api tool, with per-stage personalized instruction
 * briefs (john's rule: instructions unique + personalized per stage, and
 * overshares context). each sub-run posts its victory-condition callback
 * summary back through `discord_send`, and the supervisor validates the
 * artifact landed in the project doc.
 *
 * this module is the pure brain: stage briefs + context builders, unit
 * tested. the actual orchestration happens in the agent loop.
 */

/** per-stage briefs — personalized, opinionated, oversharing. */
export const STAGE_BRIEFS = {
  gather: {
    label: "gather (research)",
    victory: "a `## design` PRD-lite section exists in the project doc and the pipeline line reads `stage: testing-design (ready)`",
    instructions: [
      "you are the GATHER stage run. read the project doc objective + log ONLY.",
      "research the codebase and vault state for the objective.",
      "produce a `## design` section: problem, constraints, approach, user stories, a file/function-level implementation plan, explicit unknowns.",
      "design for UAT-testability from the start: assume every feature will be proven by few elite mocked end-to-end tests, not batch scripts.",
      "no blocking questions unless you truly cannot proceed — prefer multiple-choice discord_send.",
    ],
  },
  "testing-design": {
    label: "testing-design",
    victory: "a `## test plan` section exists and the pipeline line reads `stage: testing-design (awaiting sign-off)`",
    instructions: [
      "you are the TESTING-DESIGN stage run. read ONLY the objective + `## design` section.",
      "write a `## test plan` mapping every acceptance criterion to proof: what is unit-testable, what the few ELITE mocked e2e tests assert (user-visible output only), what needs live UAT.",
      "explicitly write the user-acceptance steps for john. quality over quantity: fewer, sharper tests.",
      "post a summary to discord via discord_send and set the stage line to awaiting sign-off. STOP — john must sign off.",
    ],
  },
  implement: {
    label: "implement",
    victory: "the feature branch exists with the smallest diff satisfying design + test plan, tests written + green locally, PR opened, pipeline line reads `stage: test (ready)` with the PR number",
    instructions: [
      "you are the IMPLEMENT stage run. consume ONLY the objective, `## design`, and `## test plan` sections — you are deliberately blind to other runs' deliberations.",
      "pull fresh origin/main (or the project branch), work on a feature branch.",
      "smallest amount of code that satisfies the plan. write the tests the plan calls for. keep everything injectable/testable.",
      "commit, push, open the PR, post the PR link via discord_send, update the pipeline status line.",
    ],
  },
  test: {
    label: "test (verification)",
    victory: "a verdict (PASS/FAIL) is posted to the project doc log + discord; on PASS the stage line reads `stage: done (merged?)`, on FAIL `stage: implement (ready)` + a failure report in `## log`",
    instructions: [
      "you are the TEST stage run. review the PR diff against the `## test plan` ONLY.",
      "run the suite. do the mocked e2e checks. live UAT is john's — never assume it passed.",
      "on failure: a precise failure report in `## log` (file:line, expected vs actual) and loop back to implement. two failed loops = escalate to john and STOP.",
      "on success: verdict to doc + discord, stage line to done (merged?).",
    ],
  },
};

/**
 * build the full spawn_run context for a stage run: personalized brief +
 * generous context overshare (objective, design, test plan excerpts are
 * expected to be inline in the project doc — we point at it hard and
 * inline the critical state).
 */
export function buildStageContext({ project, stage, projectDocPath, pipelineLine, extraContext = "" }) {
  const brief = STAGE_BRIEFS[stage];
  if (!brief) throw new Error(`unknown stage "${stage}" (valid: ${Object.keys(STAGE_BRIEFS).join(", ")})`);
  return [
    `purpose: eng-orchestrator`,
    `project=${project} stage=${stage}`,
    ``,
    `PROJECT DOC (read it first): ${projectDocPath}`,
    `CURRENT PIPELINE LINE: ${pipelineLine}`,
    ``,
    `=== YOUR STAGE BRIEF (personalized — do exactly this) ===`,
    `label: ${brief.label}`,
    ...brief.instructions.map((l, i) => `${i + 1}. ${l}`),
    ``,
    `=== VICTORY CONDITION (callback owed when met) ===`,
    brief.victory,
    `when the victory condition is met, call discord_send with a compact`,
    `summary (what was produced, where it lives, anything john must do).`,
    extraContext ? `\n=== EXTRA CONTEXT ===\n${extraContext}` : "",
  ].join("\n");
}
