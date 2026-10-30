#!/usr/bin/env node
/**
 * backfill-langfuse.mjs — bulk-import historical pi sessions into self-hosted langfuse.
 *
 * reads ~/.config/dude/sessions/*.jsonl (pi session format v3), converts each
 * session into one langfuse trace (OTLP/JSON) and POSTs to
 * $LANGFUSE_HOST/api/public/otel/v1/traces.
 *
 * env: LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY
 *      LANGFUSE_SESSIONS_DIR (default ~/.config/dude/sessions)
 *      LANGFUSE_BACKFILL_LIMIT (optional, max # of sessions)
 *      LANGFUSE_BACKFILL_AFTER (optional ISO date, skip sessions older than this)
 *
 * idempotent-ish: re-running re-imports as *new* traces with a "backfill:" prefix
 * in the session id, so you get duplicate traces rather than lost data. pass a
 * glob/limit to re-do specific files.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOST = (process.env.LANGFUSE_HOST || "").replace(/\/$/, "");
const PK = process.env.LANGFUSE_PUBLIC_KEY;
const SK = process.env.LANGFUSE_SECRET_KEY;
const DIR = process.env.LANGFUSE_SESSIONS_DIR || join(homedir(), ".config/dude/sessions");
const LIMIT = Number(process.env.LANGFUSE_BACKFILL_LIMIT || 0);
const AFTER = process.env.LANGFUSE_BACKFILL_AFTER ? Date.parse(process.env.LANGFUSE_BACKFILL_AFTER) : 0;
const MAX_TEXT = 8000;

if (!HOST || !PK || !SK) {
  console.error("need LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY");
  process.exit(1);
}

const auth = "Basic " + Buffer.from(`${PK}:${SK}`).toString("base64");
const RUN_TAG = "backfill-" + new Date().toISOString().replace(/[:.]/g, "-");

function trunc(s, max = MAX_TEXT) {
  if (s == null) return undefined;
  let str = typeof s === "string" ? s : JSON.stringify(s);
  if (!str) return undefined;
  return str.length > max ? str.slice(0, max) + " …[truncated]" : str;
}
const attr = (k, v) => ({
  key: k,
  value:
    typeof v === "number"
      ? { doubleValue: v }
      : typeof v === "boolean"
        ? { boolValue: v }
        : { stringValue: String(v) },
});
const id2b64 = (hex) => Buffer.from(hex, "hex").toString("base64");
const ns = (ms) => String(Math.round(ms * 1e6));
const randHex = (n) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("hex");

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content.filter((c) => c?.type === "text" && c.text).map((c) => c.text);
    if (parts.length) return parts.join("\n");
    const blocks = content.map((c) => c?.type).filter(Boolean);
    return blocks.length ? `[blocks: ${blocks.join(",")}]` : undefined;
  }
  return undefined;
}

function parseSession(file) {
  const entries = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const session = entries.find((e) => e.type === "session");
  const messages = entries.filter((e) => e.type === "message" && e.message);
  return { session, messages };
}

function entryMs(d, fallback = Date.now()) {
  // top-level timestamp is ISO; inner message.timestamp is epoch ms
  if (typeof d === "number") return d;
  const p = Date.parse(d);
  return Number.isNaN(p) ? fallback : p;
}

function buildTrace(file) {
  const { session, messages } = parseSession(file);
  const sessionId = session?.id || randHex(8);
  const traceId = sessionId.replace(/-/g, "").slice(0, 32);
  if (traceId.length !== 32) return null; // non-uuid session id — skip

  const firstUser = messages.find((m) => m.message.role === "user");
  const traceName = trunc(textOf(firstUser?.message?.content), 120) || "pi session (backfill)";

  const spans = [];
  const toolOpen = new Map(); // toolCallId -> {startMs, name, args}

  for (const e of messages) {
    const m = e.message;
    const ts = entryMs(e.timestamp, entryMs(m.timestamp));

    if (m.role === "user") {
      // close any pending tool calls at ~this time
      for (const [, t] of toolOpen) if (!t.endMs) t.endMs = ts;
    }

    if (m.role === "assistant") {
      const outText = trunc(textOf(m.content));
      const usage = m.usage || {};
      spans.push({
        traceId: id2b64(traceId),
        spanId: id2b64(randHex(8)),
        name: `llm: ${m.model || "unknown"}`,
        kind: "SPAN_KIND_INTERNAL",
        startTimeUnixNano: ns(ts),
        endTimeUnixNano: ns(ts + Math.max((usage.output || 1) * 40, 500)), // duration unknown; estimate
        attributes: [
          attr("langfuse.observation.type", "generation"),
          attr("gen_ai.system", m.provider || "unknown"),
          attr("gen_ai.request.model", m.model || "unknown"),
          attr("input.mime_type", "application/json"),
          attr("output.mime_type", "application/json"),
          ...(outText ? [attr("output.value", outText)] : []),
          ...(firstUser ? [attr("input.value", trunc(textOf(firstUser.message.content)))] : []),
          attr("gen_ai.usage.input_tokens", usage.input ?? 0),
          attr("gen_ai.usage.output_tokens", usage.output ?? 0),
          ...(usage.cost?.total != null ? [attr("langfuse.usage.total_cost", usage.cost.total)] : []),
          ...(m.stopReason ? [attr("gen_ai.response.finish_reasons", m.stopReason)] : []),
        ],
        status: { code: "STATUS_CODE_OK" },
      });
      for (const c of (m.content || []).filter((b) => b?.type === "toolCall")) {
        toolOpen.set(c.id, { startMs: ts, name: c.toolName, args: trunc(c.arguments), endMs: null });
      }
    }

    if (m.role === "toolResult") {
      const callId = m.toolCallId || m.tool_use_id;
      const open = callId && toolOpen.get(callId);
      if (open) {
        open.endMs = ts;
        toolOpen.delete(callId);
        spans.push({
          traceId: id2b64(traceId),
          spanId: id2b64(randHex(8)),
          name: `tool: ${open.name || "unknown"}`,
          kind: "SPAN_KIND_INTERNAL",
          startTimeUnixNano: ns(open.startMs),
          endTimeUnixNano: ns(Math.max(open.endMs, open.startMs + 1)),
          attributes: [
            attr("langfuse.observation.type", "span"),
            ...(open.args ? [attr("input.value", open.args)] : []),
            ...(trunc(textOf(m.content), 2000) ? [attr("output.value", trunc(textOf(m.content), 2000))] : []),
          ],
          status: { code: "STATUS_CODE_OK" },
        });
      }
    }
  }
  // close stragglers
  for (const [, t] of toolOpen) {
    if (!t.endMs) t.endMs = t.startMs + 1000;
    spans.push({
      traceId: id2b64(traceId),
      spanId: id2b64(randHex(8)),
      name: `tool: ${t.name || "unknown"} (unclosed)`,
      kind: "SPAN_KIND_INTERNAL",
      startTimeUnixNano: ns(t.startMs),
      endTimeUnixNano: ns(t.endMs),
      attributes: [attr("langfuse.observation.type", "span"), ...(t.args ? [attr("input.value", t.args)] : [])],
      status: { code: "STATUS_CODE_ERROR" },
    });
  }

  const rootSpan = {
    traceId: id2b64(traceId),
    spanId: id2b64(randHex(8)),
    name: "pi session (backfill)",
    kind: "SPAN_KIND_INTERNAL",
    startTimeUnixNano: ns(messages.length ? entryMs(messages[0].timestamp) : Date.now()),
    endTimeUnixNano: ns(messages.length ? entryMs(messages[messages.length - 1].timestamp) : Date.now()),
    attributes: [attr("langfuse.observation.type", "span"), attr("pi.session.file", file)],
    status: { code: "STATUS_CODE_OK" },
  };

  return {
    body: {
      resourceSpans: [
        {
          resource: {
            attributes: [
              attr("service.name", "pi-agent"),
              attr("langfuse.session.id", `${RUN_TAG}:${sessionId}`),
              attr("langfuse.trace.name", traceName),
              attr("langfuse.user.id", "dude-backfill"),
              attr("pi.backfill", true),
            ],
          },
          scopeSpans: [{ spans: [rootSpan, ...spans] }],
        },
      ],
    },
    sessionId,
  };
}

async function main() {
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(DIR, f))
    .filter((f) => {
      if (!AFTER) return true;
      const nameTs = Date.parse(f.split("/").pop().slice(0, 24).replace(/-/g, "-"));
      return Number.isNaN(nameTs) || nameTs >= AFTER;
    })
    .sort();
  const todo = LIMIT ? files.slice(-LIMIT) : files;
  console.log(`importing ${todo.length}/${files.length} sessions from ${DIR}`);

  let ok = 0, fail = 0, skipped = 0;
  for (const f of todo) {
    let trace;
    try {
      trace = buildTrace(f);
    } catch (e) {
      console.error(`parse fail ${f}:`, e.message);
      skipped++;
      continue;
    }
    if (!trace) {
      skipped++;
      continue;
    }
    try {
      const res = await fetch(`${HOST}/api/public/otel/v1/traces`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify(trace.body),
      });
      if (!res.ok) throw new Error(`http ${res.status}: ${(await res.text()).slice(0, 200)}`);
      ok++;
    } catch (e) {
      fail++;
      console.error(`ingest fail ${f}:`, e.message);
    }
    if ((ok + fail) % 25 === 0) console.log(`  … ${ok + fail}/${todo.length}`);
  }
  console.log(`done: ${ok} imported, ${fail} failed, ${skipped} skipped`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
