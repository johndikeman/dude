/**
 * dude2 e2e harness — the elite mocked end-to-end tests (phase-1 scope:
 * e2e-1 + e2e-5). boots the REAL dispatcher with:
 *   - a recording stub discord gateway (no real websocket)
 *   - a stub run impl (stands in for the v1 agent binary; files a reply
 *     and a run result, then exits 0)
 * and asserts the observable user-visible behavior:
 *   e2e-1: discord message -> isolated spawned run -> reply lands in-thread,
 *          zero v1 state touched
 *   e2e-5: coexistence (no shared state with v1 paths) + presence cycling
 *          from agents-state.json
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { openQueue, peekNext, complete } from "./../src/dude2/queue.js";
import { ingestDiscordMessage, createDispatcher } from "./../src/dude2/dispatcher.js";
import { loadConfig, assertIsolation } from "./../src/dude2/config.js";
import { registerRun, markExited, readState } from "./../src/dude2/registry.js";
import { presenceText } from "./../src/dude2/presence.js";
import { latestRunForChannel } from "./../src/dude2/queue.js";

/** recording stub gateway: same surface the real gateway exposes. */
function stubGateway() {
  return {
    sent: [],
    sendReply({ channelId, text, runId }) {
      this.sent.push({ channelId, text, runId });
    },
  };
}

/** stub run impl written to a temp file; the dispatcher spawns it for real
 * (real child process, real env isolation — just no model provider). */
function writeStubRunImpl(dir) {
  const file = path.join(dir, "stub-run-impl.mjs");
  fs.writeFileSync(
    file,
    `import fs from "fs";
import path from "path";
const cfgDir = process.env.DUDE2_CONFIG_DIR;
const runId = process.env.DUDE2_RUN_ID;
// exercise the per-run session dir wiring (the real agent creates it too)
fs.mkdirSync(process.env.PI_SESSION_DIR, { recursive: true });
// the "reply": the run files an outbound message with the dispatcher
const repliesDir = path.join(cfgDir, "replies");
fs.mkdirSync(repliesDir, { recursive: true });
fs.writeFileSync(path.join(repliesDir, runId + ".json"), JSON.stringify({
  runId, text: "reply from run " + runId + ": " + (process.env.DUDE2_STUB_CONTEXT || ""),
}));
// v1 convention: last-run.json handoff
fs.writeFileSync(process.env.DUDE_LAST_RUN_FILE, JSON.stringify({
  ts: new Date().toISOString(), exitCode: 0, purpose: null, pid: process.pid,
}));
process.exit(0);
`,
  );
  return file;
}

function freshEnv(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dude2-e2e-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = {
    HOME: root, // everything lands inside the sandbox root
    DUDE2_CONFIG_DIR: path.join(root, ".config/dude2"),
    DUDE2_RUN_IMPL: "",
  };
  const cfg = loadConfig(env);
  assertIsolation(cfg);
  fs.mkdirSync(cfg.configDir, { recursive: true });
  fs.mkdirSync(cfg.sessionDir, { recursive: true });
  return { root, env, cfg };
}

test("e2e-1: discord message -> isolated run -> reply in-thread; v1 state untouched", async (t) => {
  const { root, env, cfg } = freshEnv(t);
  const db = openQueue(cfg.queueDb);
  const gateway = stubGateway();
  const impl = writeStubRunImpl(root);
  env.DUDE2_RUN_IMPL = impl;
  const cfgWithImpl = { ...cfg, runImpl: impl };

  // john messages the dude2 bot
  const ingested = ingestDiscordMessage(db, {
    channelId: "chan-1",
    content: "hey dude2, do a thing",
    messageId: "msg-1",
    threadToRun: {},
  });
  assert.equal(ingested.deduped, false);

  // replay of the same discord message dedupes (at-least-once gateway delivery)
  const again = ingestDiscordMessage(db, {
    channelId: "chan-1", content: "hey dude2, do a thing", messageId: "msg-1", threadToRun: {},
  });
  assert.equal(again.deduped, true);

  const dispatcher = createDispatcher({ config: cfgWithImpl, db, gateway });

  // spawn the run through the real child-process spawner
  const entry = peekNext(db);
  const spawned = dispatcher.spawnRun({ ...entry });
  assert.ok(spawned, "run spawned");
  assert.ok(canSpawnAssertions(cfgWithImpl.agentsStateFile));

  // wait for the stub run to exit (real child process)
  const child = spawned.child;
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("stub run timed out")), 15000);
    child.on("exit", (code) => {
      clearTimeout(to);
      assert.equal(code, 0);
      resolve();
    });
  });

  // dispatcher bookkeeping: queue entry completes, registry marks done
  complete(db, entry.id, "stub finished");
  markExited(cfgWithImpl.agentsStateFile, spawned.runId, 0);
  const state = readState(cfgWithImpl.agentsStateFile);
  const run = state.runs.find((r) => r.runId === spawned.runId);
  assert.equal(run.status, "done");

  // the run's reply is forwarded to the (stub) gateway in the original channel
  dispatcher.reapReplies();
  assert.equal(gateway.sent.length, 1);
  assert.equal(gateway.sent[0].channelId, "chan-1");
  assert.match(gateway.sent[0].text, new RegExp(`reply from run ${spawned.runId}`));

  // reply in the same channel maps back to the run (us2.1 groundwork)
  assert.equal(latestRunForChannel(db, "chan-1"), spawned.runId);

  // isolation: nothing was written into any v1 path — the sandbox root has
  // no ~/.config/dude (v1) dir at all, and dude2 state is all under dude2/
  assert.ok(fs.existsSync(path.join(root, ".config/dude2/queue.db")));
  assert.ok(!fs.existsSync(path.join(root, ".config/dude")));
  assert.ok(!fs.existsSync(path.join(root, "dude-workspace")));
  // per-run session subdir exists under dude2's session dir
  assert.ok(fs.existsSync(path.join(cfg.sessionDir, spawned.runId)));
});

function canSpawnAssertions(stateFile) {
  const running = readState(stateFile).runs.filter((r) => r.status === "running");
  assert.equal(running.length, 1);
  return true;
}

test("e2e-5a: coexistence — dude2 config never collides with v1 even when v1 env is present", (t) => {
  const { env, cfg } = freshEnv(t);
  // simulate the deployed machine: v1 env vars in the environment
  env.DUDE_CONFIG_DIR = "/home/tester/.config/dude";
  env.DUDE_WORKING_DIR = "/home/tester/dude-workspace";
  env.PI_SESSION_DIR = "/home/tester/.config/dude/sessions";
  // dude2's resolved paths are still all dude2 (v1 env vars are ignored)
  const cfg2 = loadConfig(env);
  assert.ok(cfg2.configDir.endsWith("dude2"));
  assert.equal(assertIsolation(cfg2), true);
});

test("e2e-5b: presence cycles from agents-state.json with the registry state", (t) => {
  const { cfg } = freshEnv(t);
  registerRun(cfg.agentsStateFile, { runId: "run-x", purpose: "eng-orchestrator" });
  const text1 = presenceText(readState(cfg.agentsStateFile));
  assert.match(text1, /herding 1 agent \(eng-orchestrator\)/);
  markExited(cfg.agentsStateFile, "run-x", 0);
  const text2 = presenceText(readState(cfg.agentsStateFile));
  // back to an idle line once nothing is running
  assert.notEqual(text2, text1);
});
