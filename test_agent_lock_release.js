// tests for agent-lock release semantics: a foreign-pid release must be a
// no-op (so a manual-clear / crash scenario can't be "un-released" by a
// later process), and stale takeover must reclaim dead / over-aged holders.
import fs from "fs";
import os from "os";
import path from "path";
import assert from "assert";
import { acquireLock, releaseLock, readLock, isAgentRunning } from "./src/agent-lock.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dude-lock-"));
const file = path.join(dir, "agent-lock.json");

// acquire + release by same "pid"
const lock = acquireLock({ file, purpose: "test" });
assert.ok(lock);
assert.strictEqual(isAgentRunning(file), true, "lock held after acquire");

// simulate a foreign process trying to release our lock (pid mismatch)
const foreign = path.join(dir, "foreign.js");
fs.writeFileSync(foreign, "process.pid = 999999;\n");
{
  const { execFileSync } = await import("child_process");
  execFileSync(process.execPath, ["-e", `
    const { releaseLock } = await import(${JSON.stringify("./src/agent-lock.js")});
    releaseLock(${JSON.stringify(file)});
  `], { cwd: process.cwd() });
}
assert.strictEqual(isAgentRunning(file), true, "foreign release must not drop our lock");

// owner releases
releaseLock(file);
assert.strictEqual(isAgentRunning(file), false, "lock gone after owner release");

// dead holder -> stale takeover
fs.writeFileSync(file, JSON.stringify({ pid: 999999, startedAt: new Date().toISOString(), purpose: "dead" }));
assert.strictEqual(isAgentRunning(file), false, "dead-holder lock reads as stale");
const takeover = acquireLock({ file, purpose: "takeover" });
assert.ok(takeover, "takeover of dead holder succeeds");

// over-aged but alive holder -> age-stale takeover (use own pid as fake alive)
fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(), purpose: "hung" }));
assert.strictEqual(readLock(file), null, "over-aged lock reads as stale");

// releaseLock on missing/corrupt file must not throw
fs.rmSync(file);
releaseLock(file); // no throw
fs.writeFileSync(file, "not json");
releaseLock(file); // no throw

fs.rmSync(dir, { recursive: true, force: true });
console.log("test_agent_lock_release.js: all ok");
