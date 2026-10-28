/**
 * default skill paths for every run.
 *
 * regression: skills were only loaded for purpose runs (--purpose <name>),
 * so main-agent runs (discord one-offs, scheduled cycles) had no web
 * tools at all — research questions silently fell back to model knowledge
 * (2026-10-27 colibri-moe-competition / solar-laptop-cluster sessions:
 * "no web access this run — prices/versions from training cutoff").
 *
 * these are resolved from the packaged skills dir (PI_SKILLS) and always
 * added to the session; purpose-specific skillPaths are still added on top.
 */
import fs from "fs";
import path from "path";

/** packaged skills every run should have available */
export const DEFAULT_SKILL_NAMES = [
  "pi-web-browse", // web search + page fetch via headless chromium
  "browser-automation", // scripted browser control (forms, clicks)
  "github-cli", // gh usage reference
  "google-workspace", // docs/sheets/gmail access
];

/**
 * resolve the default skill paths against a skills root dir.
 * @param {string} skillsRoot value of PI_SKILLS ("" or unset -> none)
 * @returns {string[]} absolute paths that exist; never includes
 *   non-skill dirs (no SKILL.md) — pi ignores those anyway but we
 *   keep the resource loader clean.
 */
export function resolveDefaultSkillPaths(skillsRoot) {
  if (!skillsRoot) return [];
  const root = skillsRoot.replace(/\/$/, "");
  const out = [];
  for (const name of DEFAULT_SKILL_NAMES) {
    const p = path.join(root, name);
    if (fs.existsSync(p)) out.push(p);
  }
  return out;
}
