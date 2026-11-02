import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * pi-langfuse-traces: exports pi sessions to a self-hosted langfuse via OTLP/JSON.
 *
 * mapping: one langfuse trace per pi session; one generation span per LLM turn;
 * one span per tool call/result pair. attrs follow langfuse's otel conventions:
 *   langfuse.trace.name / langfuse.session.id / langfuse.observation.type
 *   gen_ai.system / gen_ai.request.model / gen_ai.usage.input_tokens ...
 *
 * configured purely via env (LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY).
 * if any of them is missing the extension goes inert so non-langfuse machines
 * are unaffected. errors are logged to stderr, never thrown into the agent loop.
 *
 * auto-enqueue (john's pick, 2026-11-01): every session trace lands in the
 * "session-review" annotation queue on shutdown so john can rate/annotate from
 * the phone UI. disable with LANGFUSE_AUTO_ENQUEUE=off; queue name overridable
 * via LANGFUSE_QUEUE_NAME. enqueue retries because trace ingestion is async —
 * the trace may not be queryable for a few seconds after the last span POST.
 */

function cfgFromEnv() {
  return {
    HOST: process.env.LANGFUSE_HOST?.replace(/\/$/, ""),
    PK: process.env.LANGFUSE_PUBLIC_KEY,
    SK: process.env.LANGFUSE_SECRET_KEY,
    QUEUE_NAME: process.env.LANGFUSE_QUEUE_NAME || "session-review",
    AUTO_ENQUEUE: (process.env.LANGFUSE_AUTO_ENQUEUE || "on").toLowerCase() !== "off",
  };
}

// exported for tests
export { cfgFromEnv };

export default function (pi: ExtensionAPI) {
  const { HOST, PK, SK, QUEUE_NAME, AUTO_ENQUEUE } = cfgFromEnv();
  if (!HOST || !PK || !SK) return;
  const MAX_TEXT = 8000; // per-field truncation; keeps payloads bounded
  const ENQUEUE_RETRIES = [1000, 2000, 4000, 8000, 15000, 30000];

  const auth = "Basic " + Buffer.from(`${PK}:${SK}`).toString("base64");
  let enabled = false;
  let traceId = "";
  let sessionId = "";
  let sessionStartMs = 0;
  let turnStartMs = 0;
  let failureCount = 0;
  let queueId: string | null = null;

  type Span = Record<string, unknown>;

  function id2b64(hex: string): string {
    return Buffer.from(hex, "hex").toString("base64");
  }

  function trunc(s: unknown, max = MAX_TEXT): string | undefined {
    if (s == null) return undefined;
    let str = typeof s === "string" ? s : JSON.stringify(s);
    if (!str) return undefined;
    return str.length > max ? str.slice(0, max) + " …[truncated]" : str;
  }

  function ns(ms: number): string {
    return String(Math.round(ms * 1e6));
  }

  function attr(key: string, value: string | number | boolean) {
    const v =
      typeof value === "number"
        ? { doubleValue: value }
        : typeof value === "boolean"
          ? { boolValue: value }
          : { stringValue: value };
    return { key, value: v };
  }

  function baseSpan(o: {
    spanId: string;
    parentSpanId?: string;
    name: string;
    startMs: number;
    endMs: number;
    type: "SPAN" | "GENERATION";
    attrs: Record<string, string | number | boolean>;
  }): Span {
    const attrs = [
      { key: "langfuse.observation.type", value: { stringValue: o.type === "GENERATION" ? "generation" : "span" } },
      ...Object.entries(o.attrs).map(([k, v]) => attr(k, v)),
    ];
    const span: Record<string, unknown> = {
      traceId: id2b64(traceId),
      spanId: id2b64(o.spanId),
      name: o.name,
      kind: "SPAN_KIND_INTERNAL",
      startTimeUnixNano: ns(o.startMs),
      endTimeUnixNano: ns(o.endMs),
      attributes: attrs,
      status: { code: "STATUS_CODE_OK" },
    };
    if (o.parentSpanId) span.parentSpanId = id2b64(o.parentSpanId);
    return span;
  }

  function post(spans: Span[]) {
    if (spans.length === 0) return;
    const body = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              attr("service.name", "pi-agent"),
              attr("langfuse.session.id", sessionId),
              attr("langfuse.trace.name", firstPrompt || "pi session"),
              attr("langfuse.user.id", process.env.USER || "unknown"),
            ],
          },
          scopeSpans: [{ spans }],
        },
      ],
    };
    fetch(`${HOST}/api/public/otel/v1/traces`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify(body),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`langfuse otel http ${r.status}`);
        failureCount = 0;
      })
      .catch((e) => {
        failureCount++;
        // stay quiet-ish: only log the first failure and then every 50th
        if (failureCount === 1 || failureCount % 50 === 0) {
          console.error(`[langfuse-traces] export failed (${failureCount}x):`, e instanceof Error ? e.message : e);
        }
      });
  }

  function randHex(n: number): string {
    return Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("hex");
  }

  function textOf(content: unknown): string | undefined {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const parts = content
        .filter((c: any) => c?.type === "text" && c.text)
        .map((c: any) => c.text);
      if (parts.length > 0) return parts.join("\n");
      const blocks = content.map((c: any) => c?.type).filter(Boolean);
      return blocks.length ? `[blocks: ${blocks.join(",")}]` : undefined;
    }
    return undefined;
  }

  // resolve queue id at session start so shutdown enqueue is immediate
  if (AUTO_ENQUEUE) void resolveQueueId().then((id) => (queueId = id));
  pi.on("session_start", async () => {
    enabled = true;
    traceId = randHex(16);
    sessionId = `pi-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    sessionStartMs = Date.now();
    firstPrompt = "";
    if (AUTO_ENQUEUE) void resolveQueueId().then((id) => (queueId = id));
  });

  pi.on("before_agent_start", async (event) => {
    if (!enabled) return;
    turnStartMs = Date.now();
    // name the trace after the first user prompt (best-effort)
    if (!firstPrompt) firstPrompt = trunc(event.prompt, 120) || "";
  });
  let firstPrompt = "";

  pi.on("turn_end", async (event) => {
    if (!enabled) return;
    const msg = event.message as any;
    if (!msg || msg.role !== "assistant") return;
    const endMs = Date.now();
    const startMs = turnStartMs || endMs - 1000;
    turnStartMs = 0;
    const spanId = randHex(8);
    const spans: Span[] = [];

    spans.push(
      baseSpan({
        spanId,
        name: `llm: ${msg.model || "unknown"}`,
        startMs,
        endMs,
        type: "GENERATION",
        attrs: {
          "gen_ai.system": String(msg.provider || "unknown"),
          "gen_ai.request.model": String(msg.model || "unknown"),
          "input.mime_type": "application/json",
          "output.mime_type": "application/json",
          ...(msg.usage
            ? {
                "gen_ai.usage.input_tokens": msg.usage.input ?? 0,
                "gen_ai.usage.output_tokens": msg.usage.output ?? 0,
                ...(msg.usage.cost?.total != null
                  ? { "langfuse.usage.total_cost": msg.usage.cost.total }
                  : {}),
              }
            : {}),
          ...(msg.stopReason ? { "gen_ai.response.finish_reasons": msg.stopReason } : {}),
          ...(firstPrompt ? { "input.value": firstPrompt.slice(0, MAX_TEXT) } : {}),          ...(textOf(msg.content) ? { "output.value": trunc(textOf(msg.content))! } : {}),
        },
      }),
    );
    firstPrompt = "";

    // tool calls as child spans (durations unknown until result arrives; use turn window)
    const calls = Array.isArray(msg.content)
      ? msg.content.filter((c: any) => c?.type === "toolCall")
      : [];
    for (const c of calls) {
      spans.push(
        baseSpan({
          spanId: c.id ? Buffer.from(String(c.id)).toString("hex").slice(0, 32).padEnd(32, "0") : randHex(8),
          parentSpanId: spanId,
          name: `tool: ${c.toolName || "unknown"}`,
          startMs,
          endMs,
          type: "SPAN",
          attrs: {
            ...(c.arguments ? { "input.value": trunc(c.arguments)! } : {}),
            "langfuse.span.input": trunc(c.arguments) || "",
          },
        }),
      );
    }

    post(spans);
  });

  // resolve the annotation queue id for QUEUE_NAME once per session; empty on miss
  async function resolveQueueId(): Promise<string | null> {
    try {
      const r = await fetch(`${HOST}/api/public/annotation-queues`, { headers: { Authorization: auth } });
      if (!r.ok) throw new Error(`http ${r.status}`);
      const data = (await r.json()) as { data: { id: string; name: string }[] };
      const q = data.data.find((x) => x.name === QUEUE_NAME);
      if (!q) {
        console.error(`[langfuse-traces] queue "${QUEUE_NAME}" not found — skipping auto-enqueue`);
        return null;
      }
      return q.id;
    } catch (e) {
      console.error("[langfuse-traces] queue lookup failed:", e instanceof Error ? e.message : e);
      return null;
    }
  }

  // enqueue this session's trace for review. retries with backoff because the
  // trace lands in langfuse's ingest pipeline asynchronously (404 until then).
  // fire-and-forget: session shutdown must not block on this.
  function enqueueTrace() {
    if (!AUTO_ENQUEUE) return;
    const objectId = id2b64(traceId); // langfuse canonical trace id form
    const attempt = async (i: number): Promise<void> => {
      try {
        const r = await fetch(`${HOST}/api/public/annotation-queues/${queueId}/items`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify({ objectType: "TRACE", objectId }),
        });
        if (r.ok) return;
        // 400 = trace not ingested yet (or already enqueued); 404 = race as well
        if ((r.status === 404 || r.status === 400) && i < ENQUEUE_RETRIES.length) {
          await new Promise((res) => setTimeout(res, ENQUEUE_RETRIES[i]));
          return attempt(i + 1);
        }
        throw new Error(`http ${r.status}`);
      } catch (e) {
        if (i < ENQUEUE_RETRIES.length && !(e instanceof TypeError)) {
          await new Promise((res) => setTimeout(res, ENQUEUE_RETRIES[i]));
          return attempt(i + 1);
        }
        console.error("[langfuse-traces] auto-enqueue failed:", e instanceof Error ? e.message : e);
      }
    };
    void attempt(0);
  }

  pi.on("session_shutdown", async () => {
    if (!enabled) return;
    // close-out span so the trace has a session-length root
    const endMs = Date.now();
    const rootId = randHex(8);
    post([
      baseSpan({
        spanId: rootId,
        name: "pi session",
        startMs: sessionStartMs || endMs,
        endMs,
        type: "SPAN",
        attrs: { "pi.session.id": sessionId },
      }),
    ]);
    if (queueId) enqueueTrace();
    else if (AUTO_ENQUEUE) void resolveQueueId().then((id) => { if (id) { queueId = id; enqueueTrace(); } });
    enabled = false;
  });

}
