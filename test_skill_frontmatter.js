/**
 * every packaged skill in .pi/skills/ must declare skill frontmatter with a
 * non-empty name and description.
 *
 * regression: meal-planner and prediction-markets shipped without any
 * frontmatter, so pi reported "no description" on project open and the
 * skills' descriptions were absent from the system prompt — progressive
 * disclosure never worked for them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

const SKILLS_DIR = path.join(import.meta.dirname, ".pi/skills");

function listSkillFiles() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(SKILLS_DIR, e.name, "SKILL.md")))
    .map((e) => path.join(SKILLS_DIR, e.name, "SKILL.md"));
}

test("every skill has frontmatter with non-empty name and description", () => {
  const files = listSkillFiles();
  assert.ok(files.length > 0, "should find at least one skill");
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const m = text.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(m, `${file}: missing frontmatter block`);
    const name = m[1].match(/^name:\s*(\S.*)$/m);
    const desc = m[1].match(/^description:\s*(\S.*)$/m);
    assert.ok(name, `${file}: missing frontmatter "name"`);
    assert.ok(desc, `${file}: missing frontmatter "description"`);
    assert.ok(desc[1].replace(/['"]/g, "").trim().length > 10, `${file}: description too short/empty`);
  }
});
