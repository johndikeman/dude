/**
 * Wait runner — event-driven invocation of dude agent purposes.
 *
 * Instead of every agent purpose running on its own dumb systemd timer
 * (and burning tokens on empty cycles), each purpose can have a *wait
 * function*: a nodejs file named for the purpose flag it should invoke.
 * Each exports:
 *
 *   async check(ctx) -> { fire: boolean, context?: string, state?: any }
 *
 *   ctx.state — whatever this function returned as `state` last run
 *               (persisted in a json cache), or null on first run
 *   return `fire: true` when the agent should run NOW; `context` is an
 *   optional string passed to the agent via --context; `state` is the
 *   new cache value stored for the next check.
 *
 * One systemd timer runs `dude-wait` frequently (hourly-ish); it runs all
 * checks and, for any that fire, invokes:
 *
 *   dude-agent --once --purpose <name> --context "<context>"
 *
 * independent of the systemd schedule for each purpose. A purpose with no
 * wait function simply keeps its regular timer.
 */

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { pathToFileURL } from "url";

const DEFAULT_FUNCTIONS_DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "wait-functions",
);

export function defaultStateFile() {
  return process.env.DUDE_WAIT_STATE_FILE ||
    path.join(
      process.env.DUDE_CONFIG_DIR || path.join(process.env.HOME || "/tmp", ".config/dude"),
      "wait-state.json",
    );
}

export function loadState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

export function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

/** list wait function names (files *.js in the dir, minus .js) */
export function listWaitFunctions(dir = process.env.DUDE_WAIT_FUNCTIONS_DIR || DEFAULT_FUNCTIONS_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => f.replace(/\.js$/, ""));
}

/**
 * load one wait function module. modules may export `purpose` to override
 * which agent flag is invoked (default: the file name). set
 * `purpose: null` to invoke the main dude agent (no --purpose flag).
 */
export async function loadWaitFunction(name, dir = process.env.DUDE_WAIT_FUNCTIONS_DIR || DEFAULT_FUNCTIONS_DIR) {
  const file = path.join(dir, `${name}.js`);
  const mod = await import(pathToFileURL(file).href);
  const fn = mod.check ?? mod.default?.check;
  if (typeof fn !== "function") {
    throw new Error(`wait function "${name}" (${file}) must export check()`);
  }
  return { check: fn, purpose: mod.purpose !== undefined ? mod.purpose : name };
}

/**
 * run a single wait function check.
 * returns { fired, context, } and persists returned state.
 */
export async function runWaitFunction(name, { dir, stateFile } = {}) {
  const statePath = stateFile || defaultStateFile();
  const state = loadState(statePath);
  const { check } = await loadWaitFunction(name, dir);
  let result;
  try {
    result = await check({ state: state[name] ?? null });
  } catch (err) {
    throw new Error(`wait function "${name}" check() failed: ${err.message}`);
  }
  if (result === null || typeof result !== "object") {
    throw new Error(`wait function "${name}" returned ${result}; expected { fire, context, state }`);
  }
  // persist state for next run (explicit `state` takes precedence; else
  // store a timestamp so the next check knows this one ran)
  state[name] = result.state !== undefined ? result.state : (state[name] ?? null);
  saveState(statePath, state);
  return { fired: !!result.fire, context: result.context || null };
}

/**
 * run all wait functions; invoke `dude-agent --once --purpose <name>
 * --context <ctx>` for every one that fires. returns summary array.
 */
export async function runAllWaitFunctions({ dir, stateFile, invoke = true, spawnFn } = {}) {
  const names = listWaitFunctions(dir);
  const results = [];
  for (const name of names) {
    let outcome;
    try {
      outcome = await runWaitFunction(name, { dir, stateFile });
      outcome._purposeInfo = await loadWaitFunction(name, dir);
    } catch (err) {
      results.push({ name, error: err.message });
      continue;
    }
    const entry = { name, fired: outcome.fired, context: outcome.context };
    if (outcome.fired && invoke) {
      const _spawn = spawnFn || spawn;
      entry.invoked = await new Promise((resolve) => {
        const { purpose } = outcome._purposeInfo;
        const args = ["--once"];
        if (purpose) args.push("--purpose", purpose);
        if (outcome.context) args.push("--context", outcome.context);
        const child = _spawn(process.execPath, [process.argv[1].replace(/wait-runner\.js$/, "index.js"), ...args], {
          stdio: "ignore",
          detached: false,
        });
        child.on("exit", (code) => resolve({ exitCode: code }));
        child.on("error", (e) => resolve({ error: e.message }));
      });
    }
    results.push(entry);
  }
  return results;
}

/** cli entry */
export async function main(argv = process.argv.slice(2)) {
  const invoke = !argv.includes("--check-only");
  const results = await runAllWaitFunctions({ invoke });
  for (const r of results) {
    if (r.error) console.error(`[wait] ${r.name}: ERROR ${r.error}`);
    else if (r.fired) console.error(`[wait] ${r.name}: FIRED (invoked)`);
    else console.error(`[wait] ${r.name}: not fired`);
  }
}

// allow `node src/wait-runner.js` direct invocation
const isMain = process.argv[1] && process.argv[1].endsWith("wait-runner.js");
if (isMain) {
  main().catch((e) => {
    console.error(`[wait] fatal: ${e.message}`);
    process.exit(1);
  });
}
