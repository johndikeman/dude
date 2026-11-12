/**
 * dude2 log export (phase 4) — export the unified run logs to supabase
 * in a langfuse-compatible trace/observation shape (john's decision:
 * start with live supabase, implementation flexible with a disk-local
 * fallback exporter so nothing blocks on cloud availability).
 *
 * env:
 *   DUDE2_EXPORT_SUPABASE_URL   — supabase project url (https://...supabase.co)
 *   DUDE2_EXPORT_SUPABASE_KEY   — service-role or anon key with insert
 *   DUDE2_EXPORT_SUPABASE_TABLE — target table (default "langfuse_traces")
 *   DUDE2_EXPORT_DIR            — disk-local fallback out dir (default
 *                                 $DUDE2_LOG_DIR/export)
 *
 * shapes (langfuse-flavored, so a langfuse run reading supabase directly
 * can consume them; kept simple on purpose):
 *   trace:       { id, timestamp, name, runId, metadata }
 *   observation: { id, traceId, timestamp, type: "log"|"agent", source, text }
 *
 * pure builders + injectable fetch for tests.
 */

import fs from "fs";
import path from "path";
import { runEntries as defaultEntriesFn } from "./logging.js";

/** build one langfuse-ish trace record for a run. */
export function buildTrace({ runId, purpose = null, startedAt = null, metadata = {} }) {
  return {
    id: `trace-${runId}`,
    timestamp: startedAt ?? new Date().toISOString(),
    name: purpose ? `dude2 run (${purpose})` : "dude2 run",
    runId,
    metadata,
  };
}

/** build langfuse-ish observation records from a run's log entries. */
export function buildObservations({ runId, entries = [] }) {
  return entries.map((e, i) => ({
    id: `obs-${runId}-${e.id ?? i}`,
    traceId: `trace-${runId}`,
    timestamp: e.ts,
    type: e.source === "agent" ? "agent" : "log",
    source: e.source,
    text: e.text,
  }));
}

/**
 * export a single run. tries supabase REST when configured; falls back to
 * writing JSONL files under the export dir. returns where it went.
 */
export async function exportRun(cfg, db, runId, { listRunsFn = null, entriesFn = null, fetchImpl = fetch } = {}) {
  const runs = listRunsFn ? listRunsFn(db, {}) : [];
  const entries = entriesFn ? entriesFn(db, runId, {}) : db ? defaultEntriesFn(db, runId, {}) : [];
  const run = runs.find((r) => r.run_id === runId) ?? null;
  const trace = buildTrace({ runId, purpose: run?.purpose ?? null, startedAt: run?.started_at ?? null });
  const observations = buildObservations({ runId, entries });

  const url = cfg.exportSupabaseUrl;
  if (url && cfg.exportSupabaseKey) {
    const res = await fetchImpl(`${url.replace(/\/$/, "")}/rest/v1/${cfg.exportSupabaseTable}`, {
      method: "POST",
      headers: {
        apikey: cfg.exportSupabaseKey,
        Authorization: `Bearer ${cfg.exportSupabaseKey}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify([{ ...trace, observations }]),
    });
    if (!res.ok) throw new Error(`supabase export failed: ${res.status} ${await res.text()}`);
    return { target: "supabase", traceId: trace.id, observations: observations.length };
  }
  // disk-local fallback: one file per run, langfuse-shaped
  const dir = cfg.exportDir;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${runId}.json`);
  fs.writeFileSync(file, JSON.stringify({ trace, observations }, null, 2));
  return { target: "disk", file, observations: observations.length };
}

/** export every completed run (backfill / scheduled exporter pass). */
export async function exportAll(cfg, db, fns = {}) {
  const runs = (fns.listRunsFn ?? ((d) => d.prepare("SELECT run_id FROM runs WHERE ended_at IS NOT NULL").all()))(db);
  const out = [];
  for (const r of runs) {
    out.push(await exportRun(cfg, db, r.run_id, fns));
  }
  return out;
}
