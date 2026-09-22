/**
 * tests for the wait runner (src/wait-runner.js)
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  listWaitFunctions,
  loadWaitFunction,
  runWaitFunction,
  runAllWaitFunctions,
  refreshWaitFunctionState,
  defaultStateFile,
} from "./src/wait-runner.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wait-"));
}

// isolation: point the agent-lock somewhere inert so tests don't collide
// with a REAL running agent (e.g. the very session running these tests).
// no lock file at this path → isAgentRunning() false everywhere.
const inertLockDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lock-"));
process.env.DUDE_AGENT_LOCK_FILE = path.join(inertLockDir, "agent-lock.json");

// sample wait functions written to a temp dir
const FLAKY_FN = `
export const purpose = "custom-purpose";
export async function check({ state }) {
  if (state === null) return { fire: false, context: null, state: 0 };
  return { fire: true, context: "changed", state: state + 1 };
}
`;
const ALWAYS_FN = `
export async function check({ state }) {
  return { fire: true, context: "go" };
}
`;

test("listWaitFunctions lists .js files", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "ai-tasks.js"), FLAKY_FN);
  fs.writeFileSync(path.join(dir, "other.js"), ALWAYS_FN);
  fs.writeFileSync(path.join(dir, "notes.md"), "not a function");
  assert.deepEqual(listWaitFunctions(dir).sort(), ["ai-tasks", "other"]);
  assert.deepEqual(listWaitFunctions(path.join(dir, "nope")), []);
});

test("loadWaitFunction defaults purpose to the file name, honors export override", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.js"), ALWAYS_FN);
  fs.writeFileSync(path.join(dir, "b.js"), "export const purpose = null;\nexport async function check() { return { fire: false }; }");
  assert.equal((await loadWaitFunction("a", dir)).purpose, "a");
  assert.equal((await loadWaitFunction("b", dir)).purpose, null);
});

test("loadWaitFunction throws when check is missing", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "bad.js"), "export default 42;");
  await assert.rejects(() => loadWaitFunction("bad", dir), /must export check/);
});

test("runWaitFunction persists state, fires on change with context", async () => {
  const dir = tmpDir();
  const stateFile = path.join(tmpDir(), "state", "wait-state.json");
  fs.writeFileSync(path.join(dir, "f.js"), FLAKY_FN);

  // first run: baseline, no fire
  let r = await runWaitFunction("f", { dir, stateFile });
  assert.equal(r.fired, false);
  assert.equal(JSON.parse(fs.readFileSync(stateFile)).f, 0);

  // second run: state present -> fires with context
  r = await runWaitFunction("f", { dir, stateFile });
  assert.equal(r.fired, true);
  assert.equal(r.context, "changed");
  assert.equal(JSON.parse(fs.readFileSync(stateFile)).f, 1);
});

test("runWaitFunction throws on bad return values / check errors", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "null.js"), "export async function check() { return null; }");
  fs.writeFileSync(path.join(dir, "boom.js"), "export async function check() { throw new Error('kaput'); }");
  await assert.rejects(() => runWaitFunction("null", { dir, stateFile: path.join(tmpDir(), "s.json") }), /returned null/);
  await assert.rejects(() => runWaitFunction("boom", { dir, stateFile: path.join(tmpDir(), "s.json") }), /kaput/);
});

test("runAllWaitFunctions invokes dude-agent with purpose + context for fired functions", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "fired.js"), ALWAYS_FN);
  fs.writeFileSync(path.join(dir, "quiet.js"), "export async function check() { return { fire: false }; }");
  const stateFile = path.join(tmpDir(), "s.json");

  const spawned = [];
  const fakeSpawn = (...callArgs) => {
    spawned.push(callArgs);
    return { on: (ev, cb) => { if (ev === "exit") setImmediate(() => cb(0)); } };
  };
  const origArgv = process.argv;
  process.argv = ["/usr/bin/node", "/path/to/dude-agent/src/index.js"];
  const results = await runAllWaitFunctions({
    dir,
    stateFile,
    invoke: true,
    spawnFn: fakeSpawn,
  });
  process.argv = origArgv;

  assert.equal(results.length, 2);
  const fired = results.find((r) => r.name === "fired");
  assert.equal(fired.fired, true);
  assert.ok(fired.invoked);
  assert.equal(spawned.length, 1);
  const [exe, args] = spawned[0];
  assert.ok(args.includes("--purpose"));
  assert.ok(args.includes("fired"));
  assert.ok(args.includes("--context"));
  assert.ok(args.includes("go"));
  const quiet = results.find((r) => r.name === "quiet");
  assert.equal(quiet.fired, false);
  assert.equal(quiet.invoked, undefined);
});

// fires once (when watched content changes), then reflects the new content
// hash as state — like the shipped ai-tasks.js wait function. simulates the
// self-fire loop: agent runs, agent edits the watched file, next tick must
// NOT fire again.
const HASH_FN = `
import crypto from "crypto";
import fs from "fs";
const WATCH = process.env.WATCH_FILE;
export async function check({ state }) {
  const hash = crypto.createHash("sha256").update(fs.readFileSync(WATCH)).digest("hex");
  if (state === null) return { fire: false, context: null, state: hash };
  if (state === hash) return { fire: false, context: null, state: hash };
  return { fire: true, context: "file changed", state: hash };
}
`;

test("refreshWaitFunctionState persists new state without firing the agent", async () => {
  const dir = tmpDir();
  const stateFile = path.join(tmpDir(), "s.json");
  const watchFile = path.join(tmpDir(), "watched.md");
  fs.writeFileSync(path.join(dir, "watch.js"), HASH_FN);
  fs.writeFileSync(watchFile, "v1\n");
  process.env.WATCH_FILE = watchFile;
  try {
    // baseline
    await runWaitFunction("watch", { dir, stateFile });
    // file changes -> fires
    fs.writeFileSync(watchFile, "v2\n");
    let r = await runWaitFunction("watch", { dir, stateFile });
    assert.equal(r.fired, true);
    // agent "edits" the file again before the next tick
    fs.writeFileSync(watchFile, "v2 + agent log\n");
    const ref = await refreshWaitFunctionState("watch", { dir, stateFile });
    assert.equal(ref.fired, true); // check() wants to fire; runner must IGNORE it
    // next tick: no fire, baseline matches
    r = await runWaitFunction("watch", { dir, stateFile });
    assert.equal(r.fired, false);
  } finally {
    delete process.env.WATCH_FILE;
  }
});

test("runAllWaitFunctions re-baselines after a clean agent run (no self-fire loop)", async () => {
  const dir = tmpDir();
  const stateFile = path.join(tmpDir(), "s.json");
  const watchFile = path.join(tmpDir(), "watched.md");
  fs.writeFileSync(path.join(dir, "watch.js"), HASH_FN);
  fs.writeFileSync(watchFile, "v1\n");
  process.env.WATCH_FILE = watchFile;
  try {
    const fakeSpawn = (...callArgs) => {
      // simulate the agent run: after being invoked it edits the watched file
      const [, args] = callArgs;
      const i = args.indexOf("--context");
      if (i !== -1) fs.writeFileSync(watchFile, fs.readFileSync(watchFile, "utf8") + "agent wrote this\n");
      return { on: (ev, cb) => { if (ev === "exit") setImmediate(() => cb(0)); } };
    };
    const origArgv = process.argv;
    process.argv = ["/usr/bin/node", "/path/to/index.js"];
    let results;
    try {
      // tick 1: baseline, no fire
      results = await runAllWaitFunctions({ dir, stateFile, invoke: true, spawnFn: fakeSpawn });
      assert.equal(results[0].fired, false);
      // file changes -> tick 2 fires; agent edits the file during its run
      fs.writeFileSync(watchFile, "v2\n");
      results = await runAllWaitFunctions({ dir, stateFile, invoke: true, spawnFn: fakeSpawn });
    } finally {
      process.argv = origArgv;
    }
    assert.equal(results[0].fired, true);
    assert.equal(results[0].invoked.exitCode, 0);
    assert.equal(results[0].rebaselined, true);
    // tick 3: agent's own edit must not re-fire
    results = await runAllWaitFunctions({ dir, stateFile, invoke: true, spawnFn: fakeSpawn });
    assert.equal(results[0].fired, false);
    assert.equal(results[0].invoked, undefined);
  } finally {
    delete process.env.WATCH_FILE;
  }
});

test("runAllWaitFunctions skips re-baseline when agent exits non-zero", async () => {
  const dir = tmpDir();
  const stateFile = path.join(tmpDir(), "s.json");
  const watchFile = path.join(tmpDir(), "watched.md");
  fs.writeFileSync(path.join(dir, "watch.js"), HASH_FN);
  fs.writeFileSync(watchFile, "v1\n");
  process.env.WATCH_FILE = watchFile;
  try {
    const fakeSpawn = () => ({ on: (ev, cb) => { if (ev === "exit") setImmediate(() => cb(1)); } });
    const origArgv = process.argv;
    process.argv = ["/usr/bin/node", "/path/to/index.js"];
    let results;
    try {
      await runAllWaitFunctions({ dir, stateFile, invoke: true, spawnFn: fakeSpawn }); // baseline
      fs.writeFileSync(watchFile, "v2\n");
      results = await runAllWaitFunctions({ dir, stateFile, invoke: true, spawnFn: fakeSpawn });
    } finally {
      process.argv = origArgv;
    }
    assert.equal(results[0].fired, true);
    assert.equal(results[0].rebaselined, undefined);
    // state still holds the fire-time hash -> next tick retries
    const st = JSON.parse(fs.readFileSync(stateFile));
    const cur = (await import("crypto")).createHash("sha256").update(fs.readFileSync(watchFile)).digest("hex");
    assert.equal(st.watch, cur);
  } finally {
    delete process.env.WATCH_FILE;
  }
});

test("refreshWaitFunctionState throws on bad return / check errors", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "null.js"), "export async function check() { return null; }");
  await assert.rejects(
    () => refreshWaitFunctionState("null", { dir, stateFile: path.join(tmpDir(), "s.json") }),
    /returned null/,
  );
});

test("runAllWaitFunctions collects errors instead of crashing", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "boom.js"), "export async function check() { throw new Error('x'); }");
  const results = await runAllWaitFunctions({ dir, stateFile: path.join(tmpDir(), "s.json"), invoke: false });
  assert.equal(results.length, 1);
  assert.match(results[0].error, /x/);
});

test("defaultStateFile falls back under config dir", () => {
  const orig = process.env.DUDE_WAIT_STATE_FILE;
  delete process.env.DUDE_WAIT_STATE_FILE;
  process.env.DUDE_CONFIG_DIR = "/tmp/fake-config";
  assert.equal(defaultStateFile(), "/tmp/fake-config/wait-state.json");
  process.env.DUDE_WAIT_STATE_FILE = "/tmp/explicit.json";
  assert.equal(defaultStateFile(), "/tmp/explicit.json");
  if (orig) process.env.DUDE_WAIT_STATE_FILE = orig;
  else delete process.env.DUDE_WAIT_STATE_FILE;
});

// ---- new behavior: lockfile, one-shot, expanded context, user dir ----

import {
  acquireLock,
  releaseLock,
  normalizeContext,
  consumeOneShot,
  listFunctionDirs,
  processPendingRebaselines,
  pendingRebaselineNames,
  recordPendingRebaseline,
} from "./src/wait-runner.js";
import { spawnSync } from "child_process";
import { writeRunResult, readLastRun } from "./src/run-result.js";
import { writeBreadcrumb, writeResumeOneShot, readBreadcrumb, clearBreadcrumb } from "./src/interrupted.js";

test("acquireLock takes the lock, blocks a second holder, releases cleanly", () => {
  const dir = tmpDir();
  const lockFile = path.join(dir, "wait-lock.json");
  assert.ok(acquireLock(lockFile));
  // second acquire with a live pid + fresh lock -> null (skip tick)
  assert.equal(acquireLock(lockFile), null);
  releaseLock(lockFile);
  assert.equal(fs.existsSync(lockFile), false);
  // after release, a new lock can be taken
  assert.ok(acquireLock(lockFile));
  releaseLock(lockFile);
});

test("acquireLock takes over a stale (dead-pid) lock", () => {
  const dir = tmpDir();
  const lockFile = path.join(dir, "wait-lock.json");
  // use a REAL dead pid (a spawned child's), not a pid guess — a guessed
  // pid can collide with a live process and flake
  const dead = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(dead.status, 0);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: dead.pid, startedAt: Date.now() }));
  const lock = acquireLock(lockFile, { staleMs: 60000 });
  assert.ok(lock);
  assert.equal(lock.pid, process.pid);
  releaseLock(lockFile);
});

test("acquireLock takes over a lock older than staleMs even if pid is alive", () => {
  const dir = tmpDir();
  const lockFile = path.join(dir, "wait-lock.json");
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() - 3 * 60 * 60 * 1000 }));
  const lock = acquireLock(lockFile, { staleMs: 2 * 60 * 60 * 1000 });
  assert.ok(lock);
  releaseLock(lockFile);
});

test("normalizeContext handles string, object, array, null", () => {
  assert.equal(normalizeContext("plain"), "plain");
  assert.deepEqual(
    normalizeContext({ summary: "hi", pr: 12, skip: null, empty: "" }).split("\n"),
    ["summary: hi", "pr: 12"],
  );
  assert.equal(normalizeContext(["a", "b"]), "a\nb");
  assert.equal(normalizeContext(null), null);
  assert.equal(normalizeContext(undefined), null);
  assert.equal(normalizeContext(42), "42");
});

test("runWaitFunction normalizes object context to text", async () => {
  const dir = tmpDir();
  const stateFile = path.join(tmpDir(), "s.json");
  fs.writeFileSync(path.join(dir, "obj.js"), `export async function check() {
  return { fire: true, context: { summary: "merged", pr: 9 } };
}`);
  const r = await runWaitFunction("obj", { dir, stateFile });
  assert.equal(r.fired, true);
  assert.equal(r.context, "summary: merged\npr: 9");
});

test("oneshot function is deleted + state cleared after a clean fire", async () => {
  const dir = tmpDir();
  const stateFile = path.join(tmpDir(), "s.json");
  fs.writeFileSync(path.join(dir, "once.js"), `export const oneshot = true;
export async function check() { return { fire: true, context: "one time" }; }`);
  const spawned = [];
  const fakeSpawn = () => ({ on: (ev, cb) => { if (ev === "exit") setImmediate(() => cb(0)); } });
  const origArgv = process.argv;
  process.argv = ["/usr/bin/node", "/path/to/index.js"];
  let results;
  try {
    results = await runAllWaitFunctions({ dir, stateFile, invoke: true, spawnFn: fakeSpawn });
  } finally {
    process.argv = origArgv;
  }
  assert.equal(results[0].fired, true);
  assert.equal(results[0].oneshotConsumed, true);
  assert.equal(fs.existsSync(path.join(dir, "once.js")), false);
  assert.equal("once" in JSON.parse(fs.readFileSync(stateFile)), false);
});

test("oneshot is NOT consumed when the agent run fails", async () => {
  const dir = tmpDir();
  const stateFile = path.join(tmpDir(), "s.json");
  fs.writeFileSync(path.join(dir, "once.js"), `export const oneshot = true;
export async function check() { return { fire: true, context: "one time" }; }`);
  const fakeSpawn = () => ({ on: (ev, cb) => { if (ev === "exit") setImmediate(() => cb(1)); } });
  const origArgv = process.argv;
  process.argv = ["/usr/bin/node", "/path/to/index.js"];
  let results;
  try {
    results = await runAllWaitFunctions({ dir, stateFile, invoke: true, spawnFn: fakeSpawn });
  } finally {
    process.argv = origArgv;
  }
  assert.equal(results[0].fired, true);
  assert.equal(results[0].oneshotConsumed, undefined);
  assert.equal(fs.existsSync(path.join(dir, "once.js")), true);
});

test("listFunctionDirs includes the user drop dir when it exists; user dir wins on load", async () => {
  const bundled = tmpDir();
  const user = tmpDir() + "/nonexistent";
  const origFn = process.env.DUDE_WAIT_FUNCTIONS_DIR;
  const origCfg = process.env.DUDE_WAIT_USER_FUNCTIONS_DIR;
  process.env.DUDE_WAIT_FUNCTIONS_DIR = bundled;
  process.env.DUDE_WAIT_USER_FUNCTIONS_DIR = user;

  // user dir missing -> only bundled
  fs.mkdirSync(user);
  assert.deepEqual(listFunctionDirs(), [bundled, user]);

  // same name in both: user version is loaded (exports different purpose)
  fs.writeFileSync(path.join(bundled, "dup.js"), "export async function check() { return { fire: false }; }");
  fs.writeFileSync(path.join(user, "dup.js"), "export const purpose = 'user-version';\nexport async function check() { return { fire: false }; }");
  assert.equal((await loadWaitFunction("dup")).purpose, "user-version");

  if (origFn) process.env.DUDE_WAIT_FUNCTIONS_DIR = origFn; else delete process.env.DUDE_WAIT_FUNCTIONS_DIR;
  if (origCfg) process.env.DUDE_WAIT_USER_FUNCTIONS_DIR = origCfg; else delete process.env.DUDE_WAIT_USER_FUNCTIONS_DIR;
});

// ---- new behavior: detached spawns + lazy pending re-baseline ----

// child-like fake for the systemd-run client spawn: exits 0 once the
// transient unit is accepted (the agent inside is not our child anymore)
const fakeDetachedSpawn = () => {
  const c = {
    stderr: { on() {} },
    on(ev, cb) {
      if (ev === "exit") setImmediate(() => cb(0));
      return c;
    },
  };
  return c;
};

const FAILING_DETACHED_SPAWN = () => {
  const c = {
    stderr: { on() {} },
    on(ev, cb) {
      if (ev === "exit") setImmediate(() => cb(1));
      return c;
    },
  };
  return c;
};

const ONESHOT_DETACHED_FN = `export const oneshot = true;
export async function check() { return { fire: true, context: "one time" }; }`;

test("detached fire: pending rebaseline recorded, nothing consumed yet", async () => {
  const dir = tmpDir();
  const stateFile = path.join(tmpDir(), "s.json");
  fs.writeFileSync(path.join(dir, "once.js"), ONESHOT_DETACHED_FN);
  const results = await runAllWaitFunctions({ dir, stateFile, invoke: true, forceDetached: true, spawnFn: fakeDetachedSpawn });
  assert.equal(results[0].fired, true);
  assert.equal(results[0].invoked.detached, true);
  // no synchronous rebaseline/consumption
  assert.equal(results[0].rebaselined, undefined);
  assert.equal(results[0].oneshotConsumed, undefined);
  // pending entry recorded
  assert.deepEqual(pendingRebaselineNames({ stateFile }), ["once"]);
  // oneshot file still there (it's consumed lazily after a clean run)
  assert.equal(fs.existsSync(path.join(dir, "once.js")), true);
});

test("lazy rebaseline: newer last-run exit 0 refreshes state + consumes oneshot", async () => {
  const dir = tmpDir();
  const stateFile = path.join(tmpDir(), "s.json");
  fs.writeFileSync(path.join(dir, "once.js"), ONESHOT_DETACHED_FN);
  const lastRunFile = path.join(tmpDir(), "last-run.json");
  const orig = process.env.DUDE_LAST_RUN_FILE;
  process.env.DUDE_LAST_RUN_FILE = lastRunFile;
  try {
    const fireResults = await runAllWaitFunctions({ dir, stateFile, invoke: true, forceDetached: true, spawnFn: fakeDetachedSpawn });
    console.error("DEBUG fire:", JSON.stringify(fireResults), "pending:", JSON.stringify(pendingRebaselineNames({ stateFile })));
    // the agent run finished cleanly after firedAt: write last-run with exit 0
    writeRunResult({ exitCode: 0, file: lastRunFile });
    const resolved = await processPendingRebaselines({ dir, stateFile });
    assert.equal(resolved[0].name, "once");
    assert.equal(resolved[0].clean, true);
    // pending cleared, oneshot consumed
    assert.deepEqual(pendingRebaselineNames({ stateFile }), []);
    assert.equal(fs.existsSync(path.join(dir, "once.js")), false);
    assert.equal("once" in JSON.parse(fs.readFileSync(stateFile)), false);
  } finally {
    if (orig) process.env.DUDE_LAST_RUN_FILE = orig; else delete process.env.DUDE_LAST_RUN_FILE;
  }
});

test("lazy rebaseline: newer last-run exit != 0 clears pending WITHOUT refresh (re-fires)", async () => {
  const dir = tmpDir();
  const stateFile = path.join(tmpDir(), "s.json");
  const watchFile = path.join(tmpDir(), "watched.md");
  fs.writeFileSync(path.join(dir, "watch.js"), HASH_FN);
  fs.writeFileSync(watchFile, "v1\n");
  process.env.WATCH_FILE = watchFile;
  const lastRunFile = path.join(tmpDir(), "last-run.json");
  const origLast = process.env.DUDE_LAST_RUN_FILE;
  const origWatch = process.env.WATCH_FILE;
  process.env.DUDE_LAST_RUN_FILE = lastRunFile;
  try {
    await runWaitFunction("watch", { dir, stateFile }); // baseline
    fs.writeFileSync(watchFile, "v2\n");
    // fire detached
    const results = await runAllWaitFunctions({ dir, stateFile, invoke: true, forceDetached: true, spawnFn: fakeDetachedSpawn });
    assert.equal(results[0].invoked.detached, true);
    // agent failed
    writeRunResult({ exitCode: 1, file: lastRunFile });
    await processPendingRebaselines({ dir, stateFile });
    assert.deepEqual(pendingRebaselineNames({ stateFile }), []);
    // state NOT refreshed: still holds the fire-time hash of v2 → next tick retries
    const cur = (await import("crypto")).createHash("sha256").update(fs.readFileSync(watchFile)).digest("hex");
    assert.equal(JSON.parse(fs.readFileSync(stateFile)).watch, cur);
  } finally {
    delete process.env.WATCH_FILE;
    if (origLast) process.env.DUDE_LAST_RUN_FILE = origLast; else delete process.env.DUDE_LAST_RUN_FILE;
    void origWatch;
  }
});

test("lazy rebaseline: no newer last-run result counts as failure (agent died uncleanly)", async () => {
  const dir = tmpDir();
  const stateFile = path.join(tmpDir(), "s.json");
  fs.writeFileSync(path.join(dir, "once.js"), ONESHOT_DETACHED_FN);
  const lastRunFile = path.join(tmpDir(), "last-run.json");
  const orig = process.env.DUDE_LAST_RUN_FILE;
  process.env.DUDE_LAST_RUN_FILE = lastRunFile;
  try {
    // a STALE result predating the fire
    fs.writeFileSync(lastRunFile, JSON.stringify({ ts: "2020-01-01T00:00:00Z", exitCode: 0 }));
    await runAllWaitFunctions({ dir, stateFile, invoke: true, forceDetached: true, spawnFn: fakeDetachedSpawn });
    await processPendingRebaselines({ dir, stateFile });
    // stale result -> not clean: no refresh, oneshot NOT consumed (retry)
    assert.deepEqual(pendingRebaselineNames({ stateFile }), []);
    assert.equal(fs.existsSync(path.join(dir, "once.js")), true);
  } finally {
    if (orig) process.env.DUDE_LAST_RUN_FILE = orig; else delete process.env.DUDE_LAST_RUN_FILE;
  }
});

test("pending rebaseline keeps a fired function from double-firing next tick", async () => {
  const dir = tmpDir();
  const stateFile = path.join(tmpDir(), "s.json");
  const watchFile = path.join(tmpDir(), "watched.md");
  fs.writeFileSync(path.join(dir, "watch.js"), HASH_FN);
  fs.writeFileSync(watchFile, "v1\n");
  process.env.WATCH_FILE = watchFile;
  const orig = process.env.WATCH_FILE;
  try {
    await runWaitFunction("watch", { dir, stateFile }); // baseline
    fs.writeFileSync(watchFile, "v2\n");
    await runAllWaitFunctions({ dir, stateFile, invoke: true, forceDetached: true, spawnFn: fakeDetachedSpawn });
    // next tick while the detached run is still unresolved: must skip, not re-fire
    const results = await runAllWaitFunctions({ dir, stateFile, invoke: true, forceDetached: true, spawnFn: fakeDetachedSpawn });
    assert.equal(results[0].skippedBusy, true);
    assert.equal(results[0].fired, undefined);
  } finally {
    delete process.env.WATCH_FILE;
    void orig;
  }
});

test("resume oneshot: fires with --resume-interrupted, consumes breadcrumb, retires when none", async () => {
  const cfg = tmpDir();
  const dir = tmpDir();
  const stateFile = path.join(tmpDir(), "s.json");
  const origCfg = process.env.DUDE_CONFIG_DIR;
  process.env.DUDE_CONFIG_DIR = cfg;
  try {
    // no breadcrumb -> writeResumeOneShot's check retires itself
    const f = writeResumeOneShot({ reason: "SIGTERM", ts: new Date().toISOString(), sessionFile: "/tmp/x.jsonl", dir });
    assert.equal(fs.existsSync(f), true);
    let results = await runAllWaitFunctions({ dir, stateFile, invoke: true, spawnFn: () => ({ on: (ev, cb) => { if (ev === "exit") setImmediate(() => cb(0)); } }) });
    const retired = results.find((r) => r.name === "resume-interrupted");
    assert.equal(retired.fired, false);
    assert.equal(fs.existsSync(f), false); // self-retired
    // with a breadcrumb: fires and clears it
    writeBreadcrumb({ reason: "SIGTERM", sessionFile: "/tmp/y.jsonl", configDir: cfg });
    writeResumeOneShot({ reason: "SIGTERM", ts: new Date().toISOString(), sessionFile: "/tmp/y.jsonl", dir });
    const spawned = [];
    results = await runAllWaitFunctions({
      dir, stateFile, invoke: true, forceDetached: false,
      spawnFn: (exe, args) => {
        assert.ok(args.includes("--resume-interrupted"));
        return { on: (ev, cb) => { if (ev === "exit") setImmediate(() => cb(0)); } };
      },
    });
    assert.equal(results.find((r) => r.name === "resume-interrupted").fired, true);
    assert.equal(readBreadcrumb({ configDir: cfg }), null);
    void spawned;
  } finally {
    if (origCfg) process.env.DUDE_CONFIG_DIR = origCfg; else delete process.env.DUDE_CONFIG_DIR;
  }
});

test("runAllWaitFunctions skips checks while an agent is busy (state untouched)", async () => {
  const dir = tmpDir();
  const stateFile = path.join(tmpDir(), "s.json");
  fs.writeFileSync(path.join(dir, "fired.js"), ALWAYS_FN);
  // simulate a live agent: lock file whose pid is this (live) test process
  const lockFile = path.join(tmpDir(), "agent-lock.json");
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const orig = process.env.DUDE_AGENT_LOCK_FILE;
  process.env.DUDE_AGENT_LOCK_FILE = lockFile;
  let results;
  try {
    results = await runAllWaitFunctions({ dir, stateFile, invoke: true, busyCheck: true });
  } finally {
    if (orig) process.env.DUDE_AGENT_LOCK_FILE = orig; else delete process.env.DUDE_AGENT_LOCK_FILE;
  }
  assert.equal(results[0].skippedBusy, true);
  // crucially: the check must NOT have run, so state stays untouched and
  // the fire is not consumed by the busy agent's exit-75
  assert.equal(fs.existsSync(stateFile), false);
});

test("detached spawn failure falls back to the synchronous path", async () => {
  const dir = tmpDir();
  const stateFile = path.join(tmpDir(), "s.json");
  fs.writeFileSync(path.join(dir, "fired.js"), ALWAYS_FN);
  const spawned = [];
  // systemd-run client exits 1 (unit rejected) -> sync fallback uses the
  // same spawnFn but with node + agentEntry argv
  const spawnFn = (exe, argv) => {
    if (exe === "systemd-run") return FAILING_DETACHED_SPAWN();
    return { on: (ev, cb) => { if (ev === "exit") setImmediate(() => cb(0)); } };
  };
  const results = await runAllWaitFunctions({ dir, stateFile, invoke: true, forceDetached: true, spawnFn });
  assert.equal(results[0].fired, true);
  // sync path result: regular exitCode, sync rebaseline happened
  assert.equal(results[0].invoked.exitCode, 0);
  assert.equal(results[0].rebaselined, true);
  assert.deepEqual(pendingRebaselineNames({ stateFile }), []);
});
