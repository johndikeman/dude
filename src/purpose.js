/**
 * Purpose registry — special-purpose agent invocations.
 *
 * Each purpose is a nodejs module in src/purposes/<name>.js exporting:
 *   {
 *     description: string,
 *     prompt: string,          // purpose-specific system prompt, appended
 *                              // to the base dude prompt
 *     skillPaths?: string[],   // extra skill dirs pulled into the session
 *   }
 *
 * The agent CLI is invoked as: dude-agent --once --purpose <name>
 * (optionally with --context "<text>" supplied by the wait runner or a
 * systemd unit). Unknown purposes throw so misconfiguration is loud.
 */

import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

const PURPOSES_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "purposes");

/** list available purpose names (filenames without .js) */
export function listPurposes(dir = PURPOSES_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => f.replace(/\.js$/, ""));
}

/**
 * load a purpose config by name.
 * @returns {Promise<{name:string, description:string, prompt:string, skillPaths:string[]}|null>}
 *          null for the default (no --purpose flag) invocation
 */
export async function loadPurpose(name, dir = PURPOSES_DIR) {
  if (!name) return null;
  const file = path.join(dir, `${name}.js`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `unknown purpose "${name}" (available: ${listPurposes(dir).join(", ") || "none"})`,
    );
  }
  const mod = await import(pathToFileURL(file).href);
  const cfg = mod.default ?? mod;
  if (!cfg || typeof cfg !== "object" || typeof cfg.prompt !== "string") {
    throw new Error(`purpose "${name}" (${file}) must export { prompt: string, ... }`);
  }
  return {
    name,
    description: cfg.description || "",
    prompt: cfg.prompt,
    skillPaths: Array.isArray(cfg.skillPaths) ? cfg.skillPaths : [],
  };
}

/**
 * parse cli args for --purpose <name> and --context <text>.
 * returns { purpose, context }
 */
export function parsePurposeArgs(argv = process.argv) {
  let purpose = null;
  let context = null;
  const i = argv.indexOf("--purpose");
  if (i !== -1 && argv[i + 1]) purpose = argv[i + 1];
  const j = argv.indexOf("--context");
  if (j !== -1 && argv[j + 1]) context = argv[j + 1];
  return { purpose, context };
}
