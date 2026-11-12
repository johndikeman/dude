/**
 * dude2 input queue — the generic dispatch layer.
 *
 * every input source (discord message, wait-runner one-shot, file drop
 * like v1's pending-stage.json, api call from another run) normalizes to
 * a single queue entry:
 *
 *   { id, source, type, context, runId?, createdAt, status }
 *
 * stored in sqlite (node:sqlite, node >=22.5) so the dispatcher gets
 * crash-safe bookkeeping for free. db path is injectable (nix rule).
 */

import { DatabaseSync } from "node:sqlite";
import crypto from "crypto";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  context TEXT,
  run_id TEXT,
  dedupe_key TEXT,
  channel_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  completed_at TEXT,
  result TEXT
);
CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status);
`;

const VALID_SOURCES = ["discord", "wait-runner", "file-drop", "api"];
const VALID_TYPES = ["prompt", "purpose", "callback"];

/**
 * normalize a raw input into a queue entry shape. throws on garbage so
 * bad inputs are loud, not silently dropped.
 */
export function normalizeInput(input) {
  if (!input || typeof input !== "object") {
    throw new Error("queue input must be an object");
  }
  if (!VALID_SOURCES.includes(input.source)) {
    throw new Error(`invalid source "${input.source}" (valid: ${VALID_SOURCES.join(", ")})`);
  }
  const type = input.type || "prompt";
  if (!VALID_TYPES.includes(type)) {
    throw new Error(`invalid type "${type}" (valid: ${VALID_TYPES.join(", ")})`);
  }
  let context = input.context ?? null;
  if (context != null && typeof context !== "string") {
    // objects/arrays render as "key: value" lines (same convention as the
    // v1 wait runner's normalizeContext)
    context = Object.entries(context)
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join("\n") || null;
  }
  return {
    source: input.source,
    type,
    context,
    runId: input.runId ?? null,
    dedupeKey: input.dedupeKey ?? null,
    channelId: input.channelId ?? null,
  };
}

/** open (and migrate) the queue db. path injectable for tests. */
export function openQueue(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
}

/**
 * enqueue one normalized input. dedupeKey entries collapse: if a pending
 * entry with the same key exists, returns its id instead of duplicating.
 */
export function enqueue(db, input) {
  const e = normalizeInput(input);
  if (e.dedupeKey) {
    const existing = db
      .prepare("SELECT id FROM queue WHERE dedupe_key = ? AND status = 'pending' LIMIT 1")
      .get(e.dedupeKey);
    if (existing) return { id: existing.id, deduped: true };
  }
  const stmt = db.prepare(
    "INSERT INTO queue (source, type, context, run_id, dedupe_key, channel_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const res = stmt.run(
    e.source,
    e.type,
    e.context,
    e.runId,
    e.dedupeKey,
    e.channelId,
    new Date().toISOString(),
  );
  return { id: Number(res.lastInsertRowid), deduped: false };
}

/** next pending entry, oldest first; null when empty. does not claim. */
export function peekNext(db) {
  const row = db
    .prepare("SELECT * FROM queue WHERE status = 'pending' ORDER BY id LIMIT 1")
    .get();
  return row ? shape(row) : null;
}

/** atomically claim the next pending entry (pending -> running). */
export function claimNext(db) {
  const row = db
    .prepare("SELECT * FROM queue WHERE status = 'pending' ORDER BY id LIMIT 1")
    .get();
  if (!row) return null;
  db.prepare("UPDATE queue SET status = 'running', claimed_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    row.id,
  );
  return shape({ ...row, status: "running" });
}

/** mark an entry done with an optional result summary (string or object). */
export function complete(db, id, result = null) {
  db.prepare("UPDATE queue SET status = 'done', completed_at = ?, result = ? WHERE id = ?").run(
    new Date().toISOString(),
    result == null ? null : typeof result === "string" ? result : JSON.stringify(result),
    id,
  );
}

/** mark an entry failed but keep it inspectable (not re-queued by default). */
export function fail(db, id, error) {
  db.prepare("UPDATE queue SET status = 'failed', completed_at = ?, result = ? WHERE id = ?").run(
    new Date().toISOString(),
    String(error).slice(0, 4000),
    id,
  );
}

/** requeue a claimed/failed entry back to pending (dispatcher retry). */
export function requeue(db, id) {
  db.prepare("UPDATE queue SET status = 'pending', claimed_at = NULL WHERE id = ?").run(id);
}

function shape(row) {
  return {
    id: Number(row.id),
    source: row.source,
    type: row.type,
    context: row.context,
    runId: row.run_id,
    dedupeKey: row.dedupe_key,
    channelId: row.channel_id,
    status: row.status,
    createdAt: row.created_at,
  };
}

/** deterministic dedupe key helper for callers (e.g. discord msg ids). */
export function dedupeKeyFor(source, ...parts) {
  return `${source}:${crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24)}`;
}

/**
 * us2.1: which run should a reply in this channel re-prompt? the most
 * recent queue entry from that channel with an assigned run. null when
 * the channel has no live run mapping.
 */
export function latestRunForChannel(db, channelId) {
  const row = db
    .prepare(
      "SELECT run_id FROM queue WHERE channel_id = ? AND run_id IS NOT NULL ORDER BY id DESC LIMIT 1",
    )
    .get(channelId);
  return row ? row.run_id : null;
}

/** persist the spawned runId onto its queue row (survives restarts). */
export function attachRun(db, queueId, runId) {
  db.prepare("UPDATE queue SET run_id = ? WHERE id = ?").run(runId, queueId);
}
