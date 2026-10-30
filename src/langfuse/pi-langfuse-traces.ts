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
 */

const HOST = process.env.LANGFUSE_HOST?.replace(/\/$/, "");
const PK = process.env.LANGFUSE_PUBLIC_KEY;
const SK = process.env.LANGFUSE_SECRET_KEY;
const MAX_TEXT = 8000; // per-field truncation; keeps payloads bounded

export default function (pi: ExtensionAPI) {
  if (!HOST || !PK || !SK) return;

  const auth = "Basic " + Buffer.from(`${PK}:${SK}`).toString("base64");
  let enabled = false;
  let traceId = "";
  let sessionId = "";
  let sessionStartMs = 0;
  let turnStartMs = 0;
  let failureCount = 0;

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

  pi.on("session_start", async () => {
    enabled = true;
    traceId = randHex(16);
    sessionId = `pi-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    sessionStartMs = Date.now();
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
    enabled = false;
  });
}
