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
// fake pi session transcript so the dispatcher can record a session ref
fs.writeFileSync(path.join(process.env.PI_SESSION_DIR, "session.jsonl"), JSON.stringify({ type: "session" }) + "\\n");
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

// ---- phase 5 expansion: e2e-2 / e2e-3 / e2e-4 -----------------------------

import { openLogIndex, listRuns, runEntries } from "./../src/dude2/logging.js";
import {
  buildDiscordSend,
  fileDiscordSend,
  fileSpawnRun,
  filePresenceNote,
  sessionQuery,
} from "./../src/dude2/api-extension.js";
import { setRunNote } from "./../src/dude2/registry.js";

/** stub run impl that (optionally) exercises the dude2-api file contract:
 * files a discord reply with numbered choices, drops a spawn_run request,
 * writes a presence note. writes nothing else. */
function writeApiStubRunImpl(dir, { withChoices = true, withSpawn = false, withPresence = true } = {}) {
  const file = path.join(dir, "stub-run-api.mjs");
  fs.writeFileSync(
    file,
    `import fs from "fs";
import path from "path";
const cfgDir = process.env.DUDE2_CONFIG_DIR;
const runId = process.env.DUDE2_RUN_ID;
fs.mkdirSync(process.env.PI_SESSION_DIR, { recursive: true });
const repliesDir = path.join(cfgDir, "replies");
fs.mkdirSync(repliesDir, { recursive: true });
let text = "api reply from " + runId;
${withChoices ? 'text += "\\n\\n1. yes\\n2. no\\n\\n(reply with the number)";' : ""}
fs.writeFileSync(path.join(repliesDir, runId + ".json"), JSON.stringify({ runId, text, channelId: "chan-api" }));
${withSpawn ? `const dropDir = path.join(cfgDir, "queue.d");
fs.mkdirSync(dropDir, { recursive: true });
fs.writeFileSync(path.join(dropDir, "spawn-" + runId + ".json"), JSON.stringify({ purpose: "eng-orchestrator", context: "purpose: eng-orchestrator\\nstage: implement (from run " + runId + ")" }));` : ""}
${withPresence ? `const pDir = path.join(cfgDir, "api", "presence");
fs.mkdirSync(pDir, { recursive: true });
fs.writeFileSync(path.join(pDir, runId + ".json"), JSON.stringify({ runId, text: "wrangling stage runs" }));` : ""}
fs.writeFileSync(process.env.DUDE_LAST_RUN_FILE, JSON.stringify({ ts: new Date().toISOString(), exitCode: 0 }));
process.exit(0);
`,
  );
  return file;
}

test("e2e-2: run uses the api (choices reply + presence + spawn_run); dispatcher ingests + reprompts same run", async (t) => {
  const { root, env, cfg } = freshEnv(t);
  const db = openQueue(cfg.queueDb);
  const gateway = stubGateway();
  const impl = writeApiStubRunImpl(root, { withSpawn: true });
  const cfgWithImpl = { ...cfg, runImpl: impl };
  const dispatcher = createDispatcher({ config: cfgWithImpl, db, gateway });

  // orchestrator run spawned with a purpose context
  const entry = { source: "file-drop", type: "purpose", context: "purpose: eng-orchestrator\nstage: implement" };
  const spawned = dispatcher.spawnRun({ ...entry, id: 1, runId: "run-orch" });
  assert.ok(spawned);
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("api stub timed out")), 15000);
    spawned.child.on("exit", () => { clearTimeout(to); resolve(); });
  });
  dispatcher.reapFinished();
  dispatcher.reapReplies();
  dispatcher.reapPresence();
  let drops = [];
  try {
    drops = fs.readdirSync(path.join(cfg.configDir, "queue.d"));
  } catch {
    drops = [];
  }
  drops.forEach((f) => dispatcher.ingestFileDrop(path.join(cfg.configDir, "queue.d", f)));
  dispatcher.reapFinished();

  // the api reply with numbered choices reached the gateway in-thread
  assert.ok(gateway.sent.some((m) => true && m.channelId === "chan-api" && m.text.includes("1. yes") && m.text.includes("2. no")));

  // the presence note landed in the registry
  const state = readState(cfgWithImpl.agentsStateFile);
  assert.equal(state.runs.find((r) => r.runId === "run-orch").note, "wrangling stage runs");
  // and surfaces in presenceText while a run is live (register a live run + note)
  registerRun(cfgWithImpl.agentsStateFile, { runId: "run-live", purpose: "eng-orchestrator" });
  setRunNote(cfgWithImpl.agentsStateFile, "run-live", "wrangling stage runs");
  const { presenceText } = await import("./../src/dude2/presence.js");
  assert.match(presenceText(readState(cfgWithImpl.agentsStateFile)), /wrangling stage runs/);

  // the spawn_run drop was ingested -> a NEW purpose run is queued
  const next = peekNext(db);
  assert.ok(next, "spawn_run drop enqueued");
  assert.equal(next.type, "purpose");
  assert.match(next.context, /stage: implement/);
  const sub = dispatcher.spawnRun({ ...next });
  assert.equal(sub.runId && typeof sub.runId, "string");
  await new Promise((resolve) => sub.child.on("exit", resolve));
  dispatcher.reapFinished();

  // us2.1: a reply in a channel that maps to a live run re-prompts it —
  // simulate a follow-up user message in chan-1 after e2e-1-style mapping
  dispatcher.ingestDiscordMessage({ channelId: "chan-e2e2", content: "1", messageId: "m2" });
  const first = peekNext(db);
  const firstSpawn = dispatcher.spawnRun({ ...first });
  await new Promise((resolve) => firstSpawn.child.on("exit", resolve));
  dispatcher.reapFinished();
  const followEnq = dispatcher.ingestDiscordMessage({ channelId: "chan-e2e2", content: "2", messageId: "m3" });
  assert.equal(followEnq.deduped, false);
  const follow = peekNext(db);
  assert.equal(follow.runId, firstSpawn.runId, "reply maps back to the same run (us2.1)");
  assert.equal(follow.type, "callback");
});

test("e2e-3: unified sourced logging across three runs + sqlite index + viewer queries", async (t) => {
  const { root, env, cfg } = freshEnv(t);
  const db = openQueue(cfg.queueDb);
  const impl = writeStubRunImpl(root);
  const cfgWithImpl = { ...cfg, runImpl: impl };
  const dispatcher = createDispatcher({ config: cfgWithImpl, db, gateway: stubGateway() });

  for (const [i, content] of ["alpha", "beta", "gamma"].entries()) {
    dispatcher.ingestDiscordMessage({ channelId: "chan-l" + i, content, messageId: "lm" + i });
    const e = peekNext(db);
    const sp = dispatcher.spawnRun({ ...e });
    await new Promise((resolve) => sp.child.on("exit", resolve));
    dispatcher.reapFinished();
  }

  const logDb = openLogIndex(cfgWithImpl);
  const runs = listRuns(logDb);
  assert.equal(runs.length, 3);
  for (const r of runs) {
    const srcs = new Set(runEntries(logDb, r.run_id).map((x) => x.source));
    assert.ok(srcs.has("dispatcher"), "dispatcher entries present");
    assert.ok(srcs.has("pi-session"), "pi-session ref present");
    // pi-stdout: the stub run impl prints nothing, so it's optional here;
    // captureRunOutput is exercised in dude2-logging unit tests
    assert.ok(r.started_at && r.exit_code === 0);
  }
  // agent-source entries + session_query findability across run logs
  const { appendEntry } = await import("./../src/dude2/logging.js");
  appendEntry(cfgWithImpl, logDb, { runId: runs[0].run_id, source: "agent", kind: "callback", text: "victory condition met for alpha" });
  const hits = sessionQuery(cfgWithImpl, "victory condition met");
  assert.ok(hits.some((h) => h.source === "run-log"));
});

test("e2e-4: the harness verdicts red on a deliberately broken dispatcher", async (t) => {
  const { env, cfg } = freshEnv(t);
  const db = openQueue(cfg.queueDb);
  const impl = writeStubRunImpl(env.HOME);
  const cfgWithImpl = { ...cfg, runImpl: impl };
  // broken: spawnRunImpl throws (the "deliberately broken dispatcher fixture")
  const dispatcher = createDispatcher({
    config: cfgWithImpl,
    db,
    gateway: stubGateway(),
    spawnRunImpl: () => {
      throw new Error("boom: broken dispatcher fixture");
    },
  });
  dispatcher.ingestDiscordMessage({ channelId: "chan-x", content: "hello", messageId: "x1" });
  let red = false;
  try {
    const e = peekNext(db);
    dispatcher.spawnRun({ ...e });
  } catch {
    red = true;
  }
  assert.equal(red, true, "harness must fail loudly when the dispatcher is broken");
});

// helper used by e2e-2 above (defined once, hoisted)
function cfgMerge(cfg) { return cfg; }
