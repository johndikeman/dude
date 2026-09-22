/**
 * tests for interrupted-run recovery (src/interrupted.js, src/run-result.js)
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  writeBreadcrumb,
  readBreadcrumb,
  clearBreadcrumb,
  writeResumeOneShot,
  buildResumePrompt,
  RESUME_ONESHOT_NAME,
} from "./src/interrupted.js";
import { writeRunResult, readLastRun, newerThan } from "./src/run-result.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "intr-"));
}

test("breadcrumb: write + read round trip, clear, TTL expiry", () => {
  const cfg = tmpDir();
  const bc = writeBreadcrumb({ reason: "SIGTERM", sessionFile: "/tmp/s.jsonl", purpose: "pm", configDir: cfg });
  assert.equal(bc.reason, "SIGTERM");
  const read = readBreadcrumb({ configDir: cfg });
  assert.equal(read.sessionFile, "/tmp/s.jsonl");
  assert.equal(read.purpose, "pm");
  // TTL: still fresh shortly after write, expired beyond TTL
  assert.ok(readBreadcrumb({ configDir: cfg, now: Date.now() + 23 * 3600 * 1000 }));
  assert.equal(readBreadcrumb({ configDir: cfg, now: Date.now() + 25 * 3600 * 1000 }), null);
  clearBreadcrumb(cfg);
  assert.equal(readBreadcrumb({ configDir: cfg }), null);
  // clear is idempotent
  assert.doesNotThrow(() => clearBreadcrumb(cfg));
});

test("resume oneshot: fixed name, embeds breadcrumb path of current config dir", () => {
  const cfg = tmpDir();
  const dir = tmpDir();
  const f = writeResumeOneShot({ reason: "SIGTERM", ts: new Date().toISOString(), sessionFile: "/s.jsonl", dir, configDir: cfg });
  assert.equal(path.basename(f), `${RESUME_ONESHOT_NAME}.js`);
  const body = fs.readFileSync(f, "utf8");
  assert.match(body, /export const oneshot = true/);
  assert.match(body, /args = \["--resume-interrupted"\]/);
  assert.ok(body.includes(cfg)); // breadcrumb path embedded (bare path inside quotes)
  assert.ok(body.includes(JSON.stringify(dir))); // self-retire path embedded
});

test("buildResumePrompt references the interruption timestamp", () => {
  const p = buildResumePrompt({ ts: "2026-09-22T01:00:00Z" }, new Date("2026-09-22T02:00:00Z"));
  assert.match(p, /2026-09-22T01:00:00Z/);
  assert.match(p, /interrupted/i);
});

test("run-result: write + read round trip, newerThan comparison", () => {
  const f = path.join(tmpDir(), "last-run.json");
  writeRunResult({ exitCode: 0, sessionFile: "/s.jsonl", file: f });
  const r = readLastRun(f);
  assert.equal(r.exitCode, 0);
  assert.equal(r.sessionFile, "/s.jsonl");
  // not newer than itself-ish timestamps
  assert.ok(newerThan(r, new Date(Date.parse(r.ts) - 1000).toISOString()));
  assert.equal(newerThan(r, r.ts), null); // strictly newer only
  assert.equal(newerThan(null, r.ts), null);
  // corrupt file -> null
  fs.writeFileSync(f, "{nope");
  assert.equal(readLastRun(f), null);
});