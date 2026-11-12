/**
 * dude2 logging + export unit tests (phase 5) — unified sourced run logs,
 * sqlite index, supabase/disk exporter shapes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  openLogIndex,
  appendEntry,
  recordRunStart,
  recordRunEnd,
  recordSessionRef,
  listRuns,
  runEntries,
  annotateRun,
  localIso,
  runLogPath,
  SOURCES,
} from "./../src/dude2/logging.js";
import {
  buildTrace,
  buildObservations,
  exportRun,
} from "./../src/dude2/log-export.js";
import { loadConfig } from "./../src/dude2/config.js";

function freshCfg(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dude2-log-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { HOME: root, DUDE2_CONFIG_DIR: path.join(root, ".config/dude2") };
  return loadConfig(env);
}

test("all four sources are tagged and land in jsonl + sqlite index", (t) => {
  const cfg = freshCfg(t);
  const db = openLogIndex(cfg);
  for (const s of SOURCES) {
    appendEntry(cfg, db, { runId: "run-1", source: s, kind: "test", text: `${s} line` });
  }
  const entries = runEntries(db, "run-1");
  assert.deepEqual(entries.map((e) => e.source), SOURCES);
  const lines = fs.readFileSync(runLogPath(cfg, "run-1"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 4);
  // local timestamp with offset, per the objective
  assert.match(lines[0].ts, /\(local\)$/);
  assert.match(lines[0].ts, /[+-]\d{4} \(local\)$/);
});

test("run lifecycle: start/exit recorded, session ref points at transcript", (t) => {
  const cfg = freshCfg(t);
  const db = openLogIndex(cfg);
  recordRunStart(cfg, db, { runId: "run-2", purpose: "eng-orchestrator", sessionFile: null });
  recordSessionRef(cfg, db, { runId: "run-2", sessionFile: "/tmp/s.jsonl" });
  recordRunEnd(cfg, db, { runId: "run-2", exitCode: 0 });
  const runs = listRuns(db);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].run_id, "run-2");
  assert.equal(runs[0].exit_code, 0);
  assert.equal(runs[0].purpose, "eng-orchestrator");
  assert.equal(runs[0].entries, 3);
  const srcs = runEntries(db, "run-2").map((e) => e.source);
  assert.deepEqual(srcs, ["dispatcher", "pi-session", "dispatcher"]);
});

test("annotateRun: rating + annotation survive a round trip", (t) => {
  const cfg = freshCfg(t);
  const db = openLogIndex(cfg);
  recordRunStart(cfg, db, { runId: "run-3" });
  annotateRun(db, "run-3", { rating: 5, annotation: "great run" });
  assert.equal(listRuns(db)[0].rating, 5);
  assert.equal(listRuns(db)[0].annotation, "great run");
});

test("exporter: disk-local fallback writes langfuse-shaped file; supabase path used when configured", async (t) => {
  const cfg = freshCfg(t);
  const db = openLogIndex(cfg);
  recordRunStart(cfg, db, { runId: "run-4", purpose: "test" });
  appendEntry(cfg, db, { runId: "run-4", source: "agent", kind: "callback", text: "victory" });
  recordRunEnd(cfg, db, { runId: "run-4", exitCode: 0 });

  // disk fallback (no supabase configured)
  const disk = await exportRun(cfg, db, "run-4");
  assert.equal(disk.target, "disk");
  const blob = JSON.parse(fs.readFileSync(disk.file, "utf8"));
  assert.equal(blob.trace.id, "trace-run-4");
  assert.ok(blob.observations.some((o) => o.traceId === "trace-run-4" && o.source === "agent"));

  // supabase path
  const cfg2 = { ...cfg, exportSupabaseUrl: "https://x.supabase.co", exportSupabaseKey: "k" };
  let posted = null;
  const supa = await exportRun(cfg2, db, "run-4", {
    fetchImpl: async (url, opts) => {
      posted = { url, opts };
      return { ok: true, status: 201, text: async () => "" };
    },
  });
  assert.equal(supa.target, "supabase");
  assert.ok(posted.url.includes("/rest/v1/langfuse_traces"));
  assert.equal(posted.opts.headers.apikey, "k");
});

test("buildTrace/buildObservations shapes are langfuse-consumable", () => {
  const trace = buildTrace({ runId: "r", purpose: "p", startedAt: "2026-01-01T00:00:00Z" });
  assert.deepEqual(Object.keys(trace).sort(), ["id", "metadata", "name", "runId", "timestamp"]);
  const obs = buildObservations({ runId: "r", entries: [{ id: 7, ts: "t", source: "pi-stdout", text: "hi" }] });
  assert.equal(obs[0].type, "log");
  assert.equal(obs[0].traceId, "trace-r");
});

test("localIso produces sortable core + explicit local offset", () => {
  const iso = localIso(new Date("2026-11-12T10:30:00Z"));
  assert.match(iso, /^2026-11-12T10:30:00\.000 [+-]\d{4} \(local\)$/);
});
