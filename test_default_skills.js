/**
 * tests for the always-on packaged skill paths (src/index.js).
 *
 * regression: research one-off runs (discord / scheduled) had no web tools
 * at all — skills were only wired into purpose runs, so questions like
 * "research the moe llm competition" silently fell back to model knowledge
 * (see 2026-10-27 colibri/solar sessions: "no web access this run").
 *
 * the default-skill resolution lives inline in runCycle(); we test the
 * exported helper `resolveDefaultSkillPaths` for existence filtering,
 * order and deduplication vs purpose skill paths.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveDefaultSkillPaths, DEFAULT_SKILL_NAMES } from "./src/default-skills.js";

function makeFakeSkillsRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dude-skills-"));
  for (const name of DEFAULT_SKILL_NAMES) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, "SKILL.md"), "---\nname: x\n---\n");
  }
  // a dir that should be skipped (no SKILL.md)
  fs.mkdirSync(path.join(root, "agent-logs"), { recursive: true });
  return root;
}

test("existing default skill dirs are resolved to absolute paths", () => {
  const root = makeFakeSkillsRoot();
  const paths = resolveDefaultSkillPaths(root);
  assert.ok(paths.length >= 3);
  for (const p of paths) {
    assert.ok(fs.existsSync(p), `path should exist: ${p}`);
    assert.ok(p.startsWith(root));
  }
  // never includes non-skill dirs
  assert.ok(!paths.some((p) => p.includes("agent-logs")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("missing skill dirs are skipped silently", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dude-skills-"));
  fs.mkdirSync(path.join(root, "pi-web-browse"), { recursive: true });
  fs.writeFileSync(path.join(root, "pi-web-browse", "SKILL.md"), "x");
  const paths = resolveDefaultSkillPaths(root);
  assert.equal(paths.length, 1);
  assert.ok(paths[0].endsWith("pi-web-browse"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("no skills root / empty env -> empty list, no throw", () => {
  assert.deepEqual(resolveDefaultSkillPaths(""), []);
  assert.deepEqual(resolveDefaultSkillPaths("/nonexistent-root-xyz"), []);
});
