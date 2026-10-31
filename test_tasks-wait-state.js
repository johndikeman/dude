// tests for tasks-wait-state: after the agent edits ai-tasks.md via the
// edit tool, the ai-tasks checklist hash in wait-state.json must be updated
// so the next wait tick doesn't re-fire the agent (self-trigger cascade).
import assert from "assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// isolate fs + env per test
function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-wait-state-"));
  process.env.OBSIDIAN_DIR = d;
  const cfg = path.join(d, "cfg");
  fs.mkdirSync(cfg, { recursive: true });
  process.env.DUDE_CONFIG_DIR = cfg;
  return d;
}

const mod = await import(
  pathToFileURL(path.resolve("./src/wait-runner/tasks-wait-state.js")).href
);
const wf = await import(
  pathToFileURL(path.resolve("./wait-functions/ai-tasks.js")).href
);
const { syncTasksWaitState, writeTasksHash, tasksFile } = mod;

// baseline hash from the wait function must match the sync module's hash
{
  const d = tmpdir();
  fs.writeFileSync(
    path.join(d, "ai-tasks.md"),
    "# tasks\n\n- [ ] one\n- [x] two\n\nprose edit noise\n",
  );
  const content = fs.readFileSync(tasksFile(), "utf8");
  const expect = wf.checklistHash(content);
  assert.strictEqual(expect, crypto.createHash("sha256").update("- [ ] one\n- [x] two").digest("hex"));

  // state file with a stale hash
  const stateFile = path.join(d, "cfg", "wait-state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ "ai-tasks": "deadbeef", "other-wait": { n: 1 } }));

  const r = syncTasksWaitState();
  assert.strictEqual(r.updated, true, "sync should report updated");
  assert.strictEqual(r.stateFile, stateFile);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.strictEqual(state["ai-tasks"], expect, "ai-tasks hash must be refreshed");
  assert.strictEqual(state["other-wait"].n, 1, "other wait state entries preserved");
}

// after a real self-edit (checklist line changed), a fresh check() with the
// synced state must NOT fire — that's the whole point
{
  const d = tmpdir();
  const f = path.join(d, "ai-tasks.md");
  fs.writeFileSync(f, "# tasks\n\n- [ ] one\n- [x] two\n");
  const stateFile = path.join(d, "cfg", "wait-state.json");
  const initial = wf.checklistHash(fs.readFileSync(f, "utf8"));
  fs.writeFileSync(stateFile, JSON.stringify({ "ai-tasks": initial }));

  // simulate the agent checking task "one" off via a self-edit
  fs.writeFileSync(f, "# tasks\n\n- [x] one\n- [x] two\n");
  const r = syncTasksWaitState();
  assert.strictEqual(r.updated, true);

  // old behavior (pre-sync): the wait function would see a changed hash and fire
  const staleState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  staleState["ai-tasks"] = initial; // what the file would hold without the fix
  const wouldFire = await wf.check({ state: staleState["ai-tasks"] });
  assert.strictEqual(wouldFire.fire, true, "sanity: without the sync fix it WOULD fire");

  // with the sync fix: state is current → no fire
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const check = await wf.check({ state: state["ai-tasks"] });
  assert.strictEqual(check.fire, false, "synced state must not re-fire the agent");
  assert.strictEqual(check.state, state["ai-tasks"]);
}

// prose-only edits don't change the hash → nothing to sync (same value written)
{
  const d = tmpdir();
  const f = path.join(d, "ai-tasks.md");
  fs.writeFileSync(f, "# tasks\n\n- [ ] one\n");
  const before = wf.checklistHash(fs.readFileSync(f, "utf8"));
  fs.writeFileSync(f, "# tasks\n\nsome new prose note\n\n- [ ] one\n");
  const r = syncTasksWaitState();
  assert.strictEqual(r.updated, true);
  assert.strictEqual(r.hash, before, "prose-only edit keeps the same checklist hash");
}

// missing task file → not updated, no throw, state file untouched
{
  const d = tmpdir();
  const stateFile = path.join(d, "cfg", "wait-state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ "ai-tasks": "oldhash" }));
  const r = syncTasksWaitState();
  assert.strictEqual(r.updated, false);
  assert.strictEqual(r.hash, null);
  assert.strictEqual(JSON.parse(fs.readFileSync(stateFile, "utf8"))["ai-tasks"], "oldhash");
}

// corrupt/missing state file → writes a fresh one with just the hash
{
  const d = tmpdir();
  fs.writeFileSync(path.join(d, "ai-tasks.md"), "- [ ] solo\n");
  const stateFile = path.join(d, "cfg", "wait-state.json");
  const r = syncTasksWaitState();
  assert.strictEqual(r.updated, true);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.deepStrictEqual(Object.keys(state), ["ai-tasks"]);
  assert.strictEqual(state["ai-tasks"], wf.checklistHash("- [ ] solo\n"));
}

import crypto from "node:crypto";
console.log("tasks-wait-state tests passed");
