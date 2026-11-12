/**
 * dude2 unified run logging (phase 4) — the "logging system improvements"
 * objective.
 *
 * per-run JSONL at $DUDE2_LOG_DIR/runs/<runId>.jsonl where every entry is
 * explicitly source-tagged:
 *   dispatcher  — spawn/exit/dispatch lineage (dispatcher process writes)
 *   pi-stdout   — captured stdout/stderr lines from the run process
 *   pi-session  — pointer entries to the pi session transcript files
 *   agent       — entries filed by the run itself (victory callbacks etc)
 *
 * every entry: { ts (local ISO with offset), runId, source, kind, text }
 *
 * a sqlite index at $DUDE2_LOG_DIR/index.db gives cheap queries across
 * runs (the log viewer + session_query read through this). all paths
 * env-driven via dude2 config (nix rule). fs/db injectable for tests.
 */

import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS log_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  run_id TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT,
  text TEXT,
  file TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT,
  ended_at TEXT,
  exit_code INTEGER,
  purpose TEXT,
  session_file TEXT,
  rating INTEGER,
  annotation TEXT
);
CREATE INDEX IF NOT EXISTS idx_log_run ON log_entries(run_id);
CREATE INDEX IF NOT EXISTS idx_log_source ON log_entries(source);
`;

export const SOURCES = ["dispatcher", "pi-stdout", "pi-session", "agent"];

/** local-time ISO with offset (objective: "time(LOCAL)"). */
export function localIso(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const mm = String(Math.abs(off) % 60).padStart(2, "0");
  return d.toISOString().replace("Z", ` ${sign}${hh}${mm}`) + ` (local)`;
  // note: iso core stays sortable; the trailing offset makes locality explicit
}

/** open (creating if needed) the log index db at cfg.logDir/index.db. */
export function openLogIndex(cfg, dbPath = null) {
  const file = dbPath ?? path.join(cfg.logDir, "index.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

/** the per-run jsonl file path. */
export function runLogPath(cfg, runId) {
  return path.join(cfg.logDir, "runs", `${runId}.jsonl`);
}

/**
 * append one sourced entry: writes the run's jsonl AND upserts into the
 * sqlite index. best-effort — logging must never crash dispatch.
 */
export function appendEntry(cfg, db, { runId, source, kind = null, text = "", file = null }, fsMod = fs) {
  const entry = { ts: localIso(), runId, source, kind, text: String(text ?? "").slice(0, 64_000), file };
  try {
    fsMod.mkdirSync(path.dirname(runLogPath(cfg, runId)), { recursive: true });
    fsMod.appendFileSync(runLogPath(cfg, runId), JSON.stringify(entry) + "\n");
    if (db) {
      db.prepare(
        "INSERT INTO log_entries (ts, run_id, source, kind, text, file) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(entry.ts, runId, source, entry.kind, entry.text, entry.file);
    }
  } catch {
    /* swallow: logging is best-effort by design */
  }
  return entry;
}

/** record run start/exit in the runs table + sourced dispatcher entries. */
export function recordRunStart(cfg, db, { runId, purpose = null, sessionFile = null }) {
  try {
    if (db) {
      db.prepare(
        "INSERT INTO runs (run_id, started_at, purpose, session_file) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(run_id) DO UPDATE SET started_at=excluded.started_at, purpose=excluded.purpose, session_file=excluded.session_file",
      ).run(runId, new Date().toISOString(), purpose, sessionFile);
    }
  } catch {
    /* best-effort */
  }
  return appendEntry(cfg, db, {
    runId,
    source: "dispatcher",
    kind: "spawn",
    text: `run started (purpose=${purpose ?? "none"}${sessionFile ? `, session=${sessionFile}` : ""})`,
  });
}

export function recordRunEnd(cfg, db, { runId, exitCode = null, endedAt = null }) {
  try {
    if (db) {
      db.prepare(
        "UPDATE runs SET ended_at = COALESCE(ended_at, ?), exit_code = ? WHERE run_id = ?",
      ).run(endedAt ?? new Date().toISOString(), exitCode, runId);
    }
  } catch {
    /* best-effort */
  }
  return appendEntry(cfg, db, {
    runId,
    source: "dispatcher",
    kind: "exit",
    text: `run exited (code=${exitCode})`,
  });
}

/** point at the pi session transcript for this run (pi-session source). */
export function recordSessionRef(cfg, db, { runId, sessionFile }) {
  return appendEntry(cfg, db, {
    runId,
    source: "pi-session",
    kind: "session-ref",
    text: "pi session transcript",
    file: sessionFile,
  });
}

/** list runs for the viewer: newest first, with entry counts. */
export function listRuns(db, { limit = 100 } = {}) {
  return db
    .prepare(
      `SELECT r.run_id, r.started_at, r.ended_at, r.exit_code, r.purpose, r.session_file, r.rating, r.annotation,
              (SELECT COUNT(*) FROM log_entries e WHERE e.run_id = r.run_id) AS entries
       FROM runs r ORDER BY COALESCE(r.started_at, r.run_id) DESC LIMIT ?`,
    )
    .all(limit);
}

/** entries for one run, optionally filtered by source. */
export function runEntries(db, runId, { source = null, limit = 1000 } = {}) {
  if (source) {
    return db
      .prepare("SELECT * FROM log_entries WHERE run_id = ? AND source = ? ORDER BY id LIMIT ?")
      .all(runId, source, limit);
  }
  return db.prepare("SELECT * FROM log_entries WHERE run_id = ? ORDER BY id LIMIT ?").all(runId, limit);
}

/** add a human rating/annotation to a run (viewer + audit use). */
export function annotateRun(db, runId, { rating = null, annotation = null }) {
  try {
    db.exec("ALTER TABLE runs ADD COLUMN rating INTEGER");
  } catch {
    /* column exists */
  }
  try {
    db.exec("ALTER TABLE runs ADD COLUMN annotation TEXT");
  } catch {
    /* column exists */
  }
  db.prepare(
    "UPDATE runs SET rating = COALESCE(?, rating), annotation = COALESCE(?, annotation) WHERE run_id = ?",
  ).run(rating, annotation, runId);
}
