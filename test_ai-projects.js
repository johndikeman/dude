// tests for the ai-projects pipeline plumbing:
//   - wait-functions/ai-projects.js: baseline / checklist-change fire / prose
//     edits don't fire, and it invokes the eng-orchestrator purpose
//   - tasks-wait-state sync: editing ai-projects.md re-baselines the
//     `ai-projects` hash so the agent's own edits don't self-trigger
//   - eng-orchestrator purpose + engineering-task skill wiring
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ai-projects-"));
  process.env.OBSIDIAN_DIR = d;
  const cfg = path.join(d, "cfg");
  fs.mkdirSync(cfg, { recursive: true });
  process.env.DUDE_CONFIG_DIR = cfg;
  return d;
}

const wf = await import(
  pathToFileURL(path.resolve("./wait-functions/ai-projects.js")).href
);
const mod = await import(
  pathToFileURL(path.resolve("./src/wait-runner/tasks-wait-state.js")).href
);
const purpose = await import(
  pathToFileURL(path.resolve("./src/purposes/eng-orchestrator.js")).href
);
const aiTasks = await import(
  pathToFileURL(path.resolve("./wait-functions/ai-tasks.js")).href
);

test("ai-projects wait function targets the eng-orchestrator purpose", () => {
  assert.equal(wf.purpose, "eng-orchestrator");
});

test("first run stores baseline without firing", async () => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, "ai-projects.md"), "# index\n\n- [ ] thing\n");
  const r = await wf.check({ state: null });
  assert.equal(r.fire, false);
  assert.equal(r.state, wf.checklistHash("- [ ] thing\n"));
});

test("checklist change fires with the checklist in context; prose edits don't", async () => {
  const d = tmpdir();
  const f = path.join(d, "ai-projects.md");
  fs.writeFileSync(f, "# index\n\n- [ ] thing\n");
  const baseline = wf.checklistHash(fs.readFileSync(f, "utf8"));

  // prose edit → no fire
  fs.writeFileSync(f, "# index\n\nsome prose noise\n\n- [ ] thing\n");
  const prose = await wf.check({ state: baseline });
  assert.equal(prose.fire, false);

  // new checklist line → fire, context carries the checklist
  fs.writeFileSync(f, "# index\n\n- [ ] thing\n- [ ] bigger thing\n");
  const fired = await wf.check({ state: baseline });
  assert.equal(fired.fire, true);
  assert.match(fired.context.currentChecklist, /- \[ \] bigger thing/);
  assert.equal(fired.state, wf.checklistHash("- [ ] thing\n- [ ] bigger thing\n"));

  // same hash → no fire
  const quiet = await wf.check({ state: fired.state });
  assert.equal(quiet.fire, false);
});

test("syncAllIndexWaitState re-baselines both index files, preserving other keys", () => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, "ai-tasks.md"), "- [ ] t1\n");
  fs.writeFileSync(path.join(d, "ai-projects.md"), "- [ ] p1\n");
  const stateFile = path.join(d, "cfg", "wait-state.json");
  fs.writeFileSync(stateFile, JSON.stringify({
    "ai-tasks": "stale",
    "ai-projects": "stale",
    "other-wait": { n: 7 },
  }));

  const results = mod.syncAllIndexWaitState();
  const byKey = Object.fromEntries(results.map((r) => [r.key, r]));
  assert.equal(byKey["ai-tasks"].updated, true);
  assert.equal(byKey["ai-projects"].updated, true);

  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state["ai-tasks"], aiTasks.checklistHash("- [ ] t1\n"));
  assert.equal(state["ai-projects"], wf.checklistHash("- [ ] p1\n"));
  assert.equal(state["other-wait"].n, 7, "unrelated wait state preserved");
});

test("agent self-edit of ai-projects.md → synced state must not re-fire", async () => {
  const d = tmpdir();
  const f = path.join(d, "ai-projects.md");
  fs.writeFileSync(f, "- [ ] p1\n");
  const initial = wf.checklistHash(fs.readFileSync(f, "utf8"));
  const stateFile = path.join(d, "cfg", "wait-state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ "ai-projects": initial }));

  // self-edit: check the box, then the extension syncs
  fs.writeFileSync(f, "- [x] p1\n");
  mod.syncAllIndexWaitState();
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const check = await wf.check({ state: state["ai-projects"] });
  assert.equal(check.fire, false, "synced state must not re-fire the orchestrator");
});

test("missing index files don't throw; they're reported not-updated", () => {
  tmpdir();
  const results = mod.syncAllIndexWaitState();
  assert.deepEqual(
    results.map((r) => r.updated),
    [false, false],
  );
});

test("eng-orchestrator purpose loads with its skill wired in", () => {
  const cfg = purpose.default ?? purpose;
  assert.ok(cfg.prompt.length > 100);
  assert.ok(cfg.prompt.includes("eng-orchestrator"));
  assert.deepEqual(cfg.skillPaths, ["engineering-task"]);
  assert.equal(cfg.trimBasePrompt, true);
  assert.ok(
    fs.existsSync(".pi/skills/engineering-task/SKILL.md"),
    "engineering-task skill dir must exist",
  );
  const skill = fs.readFileSync(".pi/skills/engineering-task/SKILL.md", "utf8");
  for (const stage of ["gather", "testing-design", "implement", "test"]) {
    assert.ok(skill.includes(stage), `skill must cover stage: ${stage}`);
  }
  assert.ok(skill.includes("sign-off"), "test plan must require john sign-off");
  // the only ai-tasks mentions must be prohibitions, not instructions
  const aiTasksLines = skill.split("\n").filter((l) => l.includes("ai-tasks"));
  assert.ok(aiTasksLines.length > 0 && aiTasksLines.every((l) => /never|don't|not touch/i.test(l)),
    "skill may only reference ai-tasks to forbid touching it");
});

console.log("ai-projects tests passed");
