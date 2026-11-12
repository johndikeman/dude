/**
 * dude2-api extension unit tests (phase 5) — pure helpers from
 * src/dude2/api-extension.js against temp dirs / injected fs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  buildDiscordSend,
  fileDiscordSend,
  fileSpawnRun,
  filePresenceNote,
  opRead,
  sessionQuery,
  repliesDir,
  queueDropDir,
  presenceDir,
} from "./../src/dude2/api-extension.js";

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dude2-api-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("discord_send builds numbered-choice payload and files a reply", (t) => {
  const payload = buildDiscordSend({
    runId: "run-a",
    text: "pick one",
    choices: ["yes", "no", "maybe"],
  });
  assert.equal(payload.runId, "run-a");
  assert.match(payload.text, /1\. yes/);
  assert.match(payload.text, /3\. maybe/);
  assert.match(payload.text, /reply with the number/);

  const dir = tmp(t);
  const file = fileDiscordSend(dir, payload);
  const roundtrip = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(roundtrip.text, payload.text);
  assert.ok(fs.existsSync(path.join(dir, "replies")));
  assert.ok(file.startsWith(repliesDir(dir)));
});

test("discord_send throws on empty text", () => {
  assert.throws(() => buildDiscordSend({ runId: "r", text: "" }));
});

test("spawn_run drops a queue.d file the dispatcher ingests (purpose vs prompt)", (t) => {
  const dir = tmp(t);
  const p = fileSpawnRun(dir, { purpose: "eng-orchestrator", context: "stage: implement" });
  assert.equal(p.type, "purpose");
  assert.ok(fs.existsSync(p.file));
  assert.ok(p.file.startsWith(queueDropDir(dir)));
  const parsed = JSON.parse(fs.readFileSync(p.file, "utf8"));
  assert.deepEqual(parsed, { purpose: "eng-orchestrator", context: "stage: implement" });

  const p2 = fileSpawnRun(dir, { context: "just a prompt" });
  assert.equal(p2.type, "prompt");
  assert.deepEqual(JSON.parse(fs.readFileSync(p2.file, "utf8")), { context: "just a prompt" });
});

test("discord_presence writes a presence note file", (t) => {
  const dir = tmp(t);
  const file = filePresenceNote(dir, "run-a", "hunting flaky tests");
  assert.ok(file.startsWith(presenceDir(dir)));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { runId: "run-a", text: "hunting flaky tests" });
});

test("op_read rejects non op:// refs before exec", () => {
  assert.throws(() => opRead("~/.ssh/id_rsa"));
  assert.throws(() => opRead("op:/nope"));
  let execed = null;
  return opRead("op://AI/item/password", (cmd, args, cb) => {
    execed = { cmd, args };
    cb(null, "s3cret");
  }).then(() => {
    assert.deepEqual(execed, { cmd: "op", args: ["read", "op://AI/item/password"] });
  });
});

test("session_query searches run logs, sessions, dispatcher log with sources", (t) => {
  const root = tmp(t);
  const cfg = {
    logDir: path.join(root, "logs"),
    sessionDir: path.join(root, "sessions"),
  };
  fs.mkdirSync(path.join(cfg.logDir, "runs"), { recursive: true });
  fs.mkdirSync(path.join(cfg.sessionDir, "run-1"), { recursive: true });
  fs.writeFileSync(path.join(cfg.logDir, "runs", "run-1.jsonl"), '{"text":"victory condition met"}\n');
  fs.writeFileSync(path.join(cfg.sessionDir, "run-1", "s.jsonl"), '{"content":"about victory conditions"}\n');
  fs.writeFileSync(path.join(cfg.logDir, "dispatcher.log"), "[d] run-1 dispatch\nunrelated\n");

  const hits = sessionQuery(cfg, "victory");
  assert.ok(hits.length >= 2);
  assert.ok(hits.some((h) => h.source === "run-log"));
  assert.ok(hits.some((h) => h.source === "pi-session"));

  const limited = sessionQuery(cfg, "victory", { limit: 1 });
  assert.equal(limited.length, 1);
  assert.equal(sessionQuery(cfg, "no-such-token-xyz").length, 0);
});
