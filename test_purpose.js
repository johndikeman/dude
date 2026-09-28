/**
 * tests for the purpose registry (src/purpose.js)
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { listPurposes, loadPurpose, parsePurposeArgs } from "./src/purpose.js";

test("loadPurpose returns null for default (no name)", async () => {
  assert.equal(await loadPurpose(null), null);
  assert.equal(await loadPurpose(undefined), null);
});

test("loadPurpose loads the prediction-markets purpose", async () => {
  const p = await loadPurpose("prediction-markets");
  assert.equal(p.name, "prediction-markets");
  assert.ok(p.prompt.length > 50);
  assert.deepEqual(p.skillPaths, ["prediction-markets"]);
});

test("loadPurpose loads the meal-planner purpose", async () => {
  const p = await loadPurpose("meal-planner");
  assert.equal(p.name, "meal-planner");
  assert.ok(p.prompt.length > 50);
  assert.ok(p.prompt.includes("meal-planner skill"));
  assert.deepEqual(p.skillPaths, ["meal-planner"]);
  assert.equal(p.trimBasePrompt, true);
  // the skill file it references must exist in the packaged skills dir
  assert.ok(
    fs.existsSync(".pi/skills/meal-planner/SKILL.md"),
    "meal-planner skill dir must exist",
  );
});

test("meal-planner state lives in the recipes vault, not a vps state dir", async () => {
  const skill = fs.readFileSync(".pi/skills/meal-planner/SKILL.md", "utf8");
  const prompt = (await loadPurpose("meal-planner")).prompt;
  // no references to the old internal state dir anywhere in the purpose
  assert.ok(!prompt.includes("~/.config/dude/meal-planner"),
    "purpose prompt must not point at the vps state dir");
  assert.ok(!skill.includes("pantry.json"),
    "skill must not reference pantry.json (replaced by inventory.md)");
  assert.ok(!skill.includes("history.jsonl"),
    "skill must not reference history.jsonl (replaced by state/history.md)");
  assert.ok(!skill.includes("prefs.json"),
    "skill must not reference prefs.json (replaced by state/prefs.md)");
  // obsidian-only state files must be named as the source of truth
  assert.ok(skill.includes("inventory.md"), "inventory.md is the on-hand truth");
  assert.ok(skill.includes("state/history.md"));
  assert.ok(skill.includes("state/prefs.md"));
  assert.ok(skill.includes("state/lastPlan.json"));
});

test("loadPurpose throws for unknown purpose", async () => {
  await assert.rejects(() => loadPurpose("does-not-exist"), /unknown purpose/);
});

test("loadPurpose throws for purpose file missing prompt export", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "purpose-"));
  fs.writeFileSync(path.join(dir, "bad.js"), "export default { nope: 1 };");
  await assert.rejects(
    () => loadPurpose("bad", dir),
    /must export \{ prompt/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadPurpose works with a module exporting check-style named default", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "purpose-"));
  fs.writeFileSync(
    path.join(dir, "ok.js"),
    "export default { description: 'd', prompt: 'do the thing' };",
  );
  const p = await loadPurpose("ok", dir);
  assert.equal(p.prompt, "do the thing");
  assert.deepEqual(p.skillPaths, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("listPurposes lists .js files without extension", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "purpose-"));
  fs.writeFileSync(path.join(dir, "a.js"), "");
  fs.writeFileSync(path.join(dir, "b.js"), "");
  fs.writeFileSync(path.join(dir, "c.txt"), "");
  assert.deepEqual(listPurposes(dir), ["a", "b"]);
  assert.deepEqual(listPurposes(path.join(dir, "missing")), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("parsePurposeArgs extracts --purpose and --context", () => {
  const argv = ["node", "dude-agent", "--once", "--purpose", "pm", "--context", "hi there"];
  assert.deepEqual(parsePurposeArgs(argv), { purpose: "pm", context: "hi there" });
  assert.deepEqual(parsePurposeArgs(["node", "dude-agent", "--once"]), {
    purpose: null,
    context: null,
  });
  // context with no following value is ignored
  assert.deepEqual(parsePurposeArgs(["node", "x", "--context"]), {
    purpose: null,
    context: null,
  });
});
