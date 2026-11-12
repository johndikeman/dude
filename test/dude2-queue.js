/**
 * tests for src/dude2/queue.js — input normalization, dedupe, claim/complete.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { openQueue, normalizeInput, enqueue, peekNext, claimNext, complete, fail, requeue, dedupeKeyFor } from "./../src/dude2/queue.js";

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dude2-q-"));
  return openQueue(path.join(dir, "queue.db"));
}

test("normalizeInput: valid sources/types; object context renders as key: value lines", () => {
  const e = normalizeInput({ source: "discord", context: { a: "1", b: "two" } });
  assert.equal(e.source, "discord");
  assert.equal(e.type, "prompt");
  assert.equal(e.context, "a: 1\nb: two");
  assert.equal(normalizeInput({ source: "api", type: "callback", context: "x" }).type, "callback");
});

test("normalizeInput throws on invalid source/type", () => {
  assert.throws(() => normalizeInput({ source: "carrier-pigeon" }), /invalid source/);
  assert.throws(() => normalizeInput({ source: "api", type: "teleport" }), /invalid type/);
  assert.throws(() => normalizeInput(null), /object/);
});

test("enqueue + peekNext + claimNext oldest-first ordering", () => {
  const db = tmpDb();
  enqueue(db, { source: "api", context: "first" });
  enqueue(db, { source: "api", context: "second" });
  assert.equal(peekNext(db).context, "first");
  const claimed = claimNext(db);
  assert.equal(claimed.status, "running");
  assert.equal(claimed.context, "first");
  // claim consumes: next claim gets the second
  assert.equal(claimNext(db).context, "second");
  assert.equal(claimNext(db), null);
});

test("dedupe: same dedupeKey while pending collapses to the existing id", () => {
  const db = tmpDb();
  const a = enqueue(db, { source: "discord", context: "hi", dedupeKey: "discord:abc" });
  const b = enqueue(db, { source: "discord", context: "hi again", dedupeKey: "discord:abc" });
  assert.equal(b.id, a.id);
  assert.equal(b.deduped, true);
  // after completion, the same key may enqueue again
  complete(db, a.id);
  const c = enqueue(db, { source: "discord", context: "later", dedupeKey: "discord:abc" });
  assert.notEqual(c.id, a.id);
});

test("complete/fail/requeue lifecycle", () => {
  const db = tmpDb();
  const { id } = enqueue(db, { source: "wait-runner", context: "task" });
  claimNext(db);
  fail(db, id, "boom");
  const failed = db.prepare("SELECT status, result FROM queue WHERE id = ?").get(id);
  assert.equal(failed.status, "failed");
  assert.match(failed.result, /boom/);
  requeue(db, id);
  assert.equal(db.prepare("SELECT status FROM queue WHERE id = ?").get(id).status, "pending");
  const c = claimNext(db);
  complete(db, c.id, { summary: "done" });
  assert.equal(db.prepare("SELECT status FROM queue WHERE id = ?").get(id).status, "done");
});

test("dedupeKeyFor is deterministic and source-scoped", () => {
  assert.equal(dedupeKeyFor("discord", "m1"), dedupeKeyFor("discord", "m1"));
  assert.notEqual(dedupeKeyFor("discord", "m1"), dedupeKeyFor("wait-runner", "m1"));
});
