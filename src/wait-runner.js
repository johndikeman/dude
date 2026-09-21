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
 * One systemd timer runs `dude-wait` frequently (every 15 minutes); it
 * runs all checks and, for any that fire, invokes:
 *
 *   dude-agent --once --purpose <name> --context "<context>"
 *
 * independent of the systemd schedule for each purpose. A purpose with no
 * wait function simply keeps its regular timer. context may be a string,
 * an object of key->value (rendered as "key: value" lines) or an array of
 * strings (joined). functions may export `oneshot: true` to be deleted
 * after their first successful fire. a lock file prevents overlapping
 * ticks and skipped runs while another agent run is in flight.
 */

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { isAgentRunning } from "./agent-lock.js";

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

export function defaultLockFile() {
  return process.env.DUDE_WAIT_LOCK_FILE ||
    path.join(
      process.env.DUDE_CONFIG_DIR || path.join(process.env.HOME || "/tmp", ".config/dude"),
      "wait-lock.json",
    );
}

/**
 * acquire an exclusive lock for a wait-runner tick. prevents two ticks
 * (or a tick and a fired agent run still in flight) from stepping on one
 * another, and stops self-trigger cascades when a long agent run overlaps
 * the next timer fire.
 *
 * lock file format: { pid, startedAt }. rules:
 *   - no lock file            -> create it, we hold the lock
 *   - file exists, pid alive  -> someone else is running: return null (skip)
 *   - file exists, pid dead   -> stale (e.g. OOM kill): take over
 *   - file older than STALE_MS regardless -> take over (clock drift safety)
 */
export const LOCK_STALE_MS = 2 * 60 * 60 * 1000; // 2h: longer than any sane agent run

export function acquireLock(file = defaultLockFile(), { staleMs = LOCK_STALE_MS, now = Date.now() } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let existing = null;
  try {
    existing = JSON.parse(fs.readFileSync(file, "utf8"));
    // an existing lock whose pid is alive means another tick/run holds it.
    // check process liveness (signal 0); node throws EPERM for a live pid
    // owned by another user, which still means "alive".
    let alive = false;
    try {
      process.kill(existing.pid, 0);
      alive = true;
    } catch (err) {
      alive = err.code === "EPERM";
    }
    const age = now - (existing.startedAt || 0);
    if (alive && age < staleMs) return null; // skip this tick
  } catch {
    existing = null; // missing/corrupt file: treat as no lock
  }
  const lock = { pid: process.pid, startedAt: now };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lock));
  try {
    // rename is atomic-ish; if another process raced us and created its
    // own lock after we read, its rename will have overwritten ours —
    // for a single-user systemd timer this race is vanishingly rare and
    // the pid-liveness check above is the real guard.
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* renamed ok */ }
  }
  return lock;
}

/** release the lock (only if we still hold it). non-fatal on failure. */
export function releaseLock(file = defaultLockFile()) {
  try {
    const lock = JSON.parse(fs.readFileSync(file, "utf8"));
    if (lock.pid === process.pid) fs.unlinkSync(file);
  } catch { /* already gone / unreadable: nothing to do */ }
}

/**
 * normalize a wait function's context value to a plain string for
 * --context. functions may return a string, an object of key->string
 * (rendered as "key: value" lines), or an array of strings (joined).
 * this is the "expanded context values" interface — richer payloads
 * without changing the single --context flag.
 */
export function normalizeContext(context) {
  if (context == null) return null;
  if (typeof context === "string") return context;
  if (Array.isArray(context)) {
    return context.map(normalizeContext).filter(Boolean).join("\n") || null;
  }
  if (typeof context === "object") {
    const lines = Object.entries(context)
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
    return lines.join("\n") || null;
  }
  return String(context);
}

/**
 * the effective functions dirs: the bundled one (nix store, read-only)
 * plus a user-writable drop dir at $DUDE_CONFIG_DIR/wait-functions.d where
 * agents install their own custom/one-shot wait functions. both are
 * scanned; later dirs win on name collision (user dir comes last).
 */
export function listFunctionDirs(bundledDir = process.env.DUDE_WAIT_FUNCTIONS_DIR || DEFAULT_FUNCTIONS_DIR) {
  const userDir = process.env.DUDE_WAIT_USER_FUNCTIONS_DIR ||
    path.join(
      process.env.DUDE_CONFIG_DIR || path.join(process.env.HOME || "/tmp", ".config/dude"),
      "wait-functions.d",
    );
  // ensure the drop dir exists so agent runs can write wait functions into
  // it without racing the dir-creation
  try { fs.mkdirSync(userDir, { recursive: true }); } catch { /* read-only env: dir check below still applies */ }
  return fs.existsSync(userDir) ? [bundledDir, userDir] : [bundledDir];
}

/** list wait function names (files *.js across all functions dirs, minus .js) */
export function listWaitFunctions(dir) {
  const dirs = dir ? [dir] : listFunctionDirs();
  const names = new Set();
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (f.endsWith(".js")) names.add(f.replace(/\.js$/, ""));
    }
  }
  return [...names];
}

/**
 * load one wait function module by name (searched across all functions
 * dirs, user dir last so it wins). modules may export `purpose` to
 * override which agent flag is invoked (default: the file name; set
 * `purpose: null` to invoke the main dude agent). export `oneshot: true`
 * to have the function deleted after its first successful fire.
 */
export async function loadWaitFunction(name, dir) {
  const dirs = dir ? [dir] : listFunctionDirs();
  let file = null;
  for (const d of dirs) {
    const candidate = path.join(d, `${name}.js`);
    if (fs.existsSync(candidate)) file = candidate;
  }
  if (!file) {
    throw new Error(`wait function "${name}" not found in: ${dirs.join(", ")}`);
  }
  const mod = await import(pathToFileURL(file).href);
  const fn = mod.check ?? mod.default?.check;
  if (typeof fn !== "function") {
    throw new Error(`wait function "${name}" (${file}) must export check()`);
  }
  return { check: fn, purpose: mod.purpose !== undefined ? mod.purpose : name, oneshot: mod.oneshot === true };
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
  result = { ...result, context: normalizeContext(result.context) };
  // persist state for next run (explicit `state` takes precedence; else
  // store a timestamp so the next check knows this one ran)
  state[name] = result.state !== undefined ? result.state : (state[name] ?? null);
  saveState(statePath, state);
  return { fired: !!result.fire, context: result.context || null };
}

/**
 * re-run a wait function's check() and persist the returned state WITHOUT
 * invoking the agent. used after a fired agent run completes: the agent
 * typically edits whatever the wait function watches (e.g. appends its log
 * to ai-tasks.md), and without this refresh the next tick sees that
 * self-written change as "new" and fires again — an idle self-fire loop.
 *
 * a refresh failure is non-fatal (logged, original state kept).
 */
export async function refreshWaitFunctionState(name, { dir, stateFile } = {}) {
  const statePath = stateFile || defaultStateFile();
  const state = loadState(statePath);
  const { check } = await loadWaitFunction(name, dir);
  let result;
  try {
    result = await check({ state: state[name] ?? null });
  } catch (err) {
    throw new Error(`wait function "${name}" refresh check() failed: ${err.message}`);
  }
  if (result === null || typeof result !== "object") {
    throw new Error(`wait function "${name}" returned ${result}; expected { fire, context, state }`);
  }
  if (result.state !== undefined) {
    state[name] = result.state;
    saveState(statePath, state);
  }
  return { fired: !!result.fire, context: result.context || null };
}

/**
 * one-shot waits: a wait function module may export `oneshot: true` (or
 * return `oneshot: true` from check()). after such a function FIRES and
 * its agent run completes cleanly, the runner deletes the function file
 * and clears its persisted state — the wait is consumed. used when an
 * agent builds a custom "wake me when X happens, once" trigger for a
 * future version of itself (see the wait-functions skill).
 */
export function consumeOneShot(name, { dir, stateFile } = {}) {
  const dirs = dir ? [dir] : listFunctionDirs();
  for (const d of dirs) {
    try { fs.unlinkSync(path.join(d, `${name}.js`)); } catch { /* not here */ }
  }
  if (stateFile) {
    const state = loadState(stateFile);
    if (name in state) {
      delete state[name];
      saveState(stateFile, state);
    }
  }
  return true;
}

/**
 * run all wait functions; invoke `dude-agent --once --purpose <name>
 * --context <ctx>` for every one that fires. after a fired agent run
 * EXITS CLEANLY, re-baselines that function's state (see
 * refreshWaitFunctionState) so the agent's own writes to the watched
 * thing don't re-trigger it. on non-zero exit the state is left alone so
 * the next tick retries. one-shot functions (export `oneshot: true`)
 * are deleted after a clean fire. returns summary array.
 */
export async function runAllWaitFunctions({ dir, stateFile, invoke = true, spawnFn, busyCheck = true } = {}) {
  const names = listWaitFunctions(dir);
  const results = [];
  for (const name of names) {
    // if an agent run is already in flight (scheduled timer run, PM
    // purpose, discord trigger...), don't even run the check: running it
    // would persist new state and consume the event, while the fired agent
    // would just skip itself (exit 75). skipping the check leaves state
    // untouched so the function re-fires on the next tick.
    if (busyCheck && invoke && isAgentRunning()) {
      results.push({ name, skippedBusy: true });
      continue;
    }
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
        // resolve the agent entry relative to THIS module (robust against
        // being invoked through the dude-wait bin symlink, where
        // process.argv[1] doesn't end in wait-runner.js)
        const agentEntry = fileURLToPath(new URL("./index.js", import.meta.url));
        const child = _spawn(process.execPath, [agentEntry, ...args], {
          stdio: "ignore",
          detached: false,
        });
        child.on("exit", (code) => resolve({ exitCode: code }));
        child.on("error", (e) => resolve({ error: e.message }));
      });
      if (entry.invoked && entry.invoked.exitCode === 0) {
        // re-baseline the function's state so the agent's own writes to the
        // watched thing don't re-trigger it on the next tick
        try {
          await refreshWaitFunctionState(name, { dir, stateFile });
          entry.rebaselined = true;
        } catch (err) {
          console.error(`[wait] ${err.message}`);
        }
        // one-shot: the wait is consumed after a clean run
        if (outcome._purposeInfo.oneshot) {
          consumeOneShot(name, { dir, stateFile });
          entry.oneshotConsumed = true;
          console.error(`[wait] ${name}: one-shot consumed (function removed)`);
        }
      }
    }
    results.push(entry);
  }
  return results;
}

/** cli entry */
export async function main(argv = process.argv.slice(2)) {
  const invoke = !argv.includes("--check-only");
  // single-instance lock: if another tick (or a fired agent run) is still
  // in flight, skip this tick entirely instead of stacking agent runs.
  const lockFile = defaultLockFile();
  const lock = acquireLock(lockFile);
  if (!lock) {
    console.error(`[wait] another run holds ${lockFile}; skipping tick`);
    return;
  }
  const cleanup = () => releaseLock(lockFile);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });
  try {
    const results = await runAllWaitFunctions({ invoke });
    for (const r of results) {
      if (r.error) console.error(`[wait] ${r.name}: ERROR ${r.error}`);
      else if (r.skippedBusy) console.error(`[wait] ${r.name}: skipped (agent run in progress; will re-fire next tick)`);
      else if (r.oneshotConsumed) console.error(`[wait] ${r.name}: FIRED (one-shot consumed)`);
      else if (r.fired) console.error(`[wait] ${r.name}: FIRED (invoked)`);
      else console.error(`[wait] ${r.name}: not fired`);
    }
  } finally {
    cleanup();
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
