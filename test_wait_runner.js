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
  defaultStateFile,
} from "./src/wait-runner.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wait-"));
}

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
