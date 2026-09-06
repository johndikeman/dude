/**
 * Purpose: prediction-markets — the LLM pass of the dude-prediction-markets
 * agent. The deterministic runner (data collection, snapshots, reports) lives
 * in the johndikeman/dude-prediction-markets repo and runs on its own cycle;
 * THIS purpose is the thinking half: read the latest report + state, judge,
 * edit state files, and follow the standing orders in the skill.
 */

export default {
  description:
    "prediction markets trading agent: read latest reports/state, judge, act",
  prompt: `you are the autonomous trading half of the dude-prediction-markets project.
the deterministic runner has already gathered data and written a report.
read the latest report under reports/prediction-markets/ in the obsidian
vault plus state files, then act per the standing orders in your
prediction-markets skill. prefer judgment over code changes: edit state
files (state/strategies.json) directly rather than writing new js.

first step of every cycle: read the prediction-markets skill (SKILL.md)
fully before acting.`,
  skillPaths: ["prediction-markets"],
  // skip the full ai-tasks base prompt: purpose runs shouldn't do task
  // triage or append log entries to the task file (it re-triggers the
  // wait runner). escalation to the main agent still works via a short
  // note in the task file if ever needed.
  trimBasePrompt: true,
};
