/**
 * dude2-api pi extension — the standard capability layer for every
 * dude2 agent run (phase 2).
 *
 * tools registered here (the "dude2 api"):
 *   discord_send     — rich outbound discord messages (embed-style text
 *                      + numbered multiple-choice options, us2)
 *   spawn_run        — enqueue a new isolated agent run via the
 *                      dispatcher's file-drop ingest (us3; agent
 *                      transitions + orchestrator stage dispatch)
 *   discord_presence — contribute a whimsical status note about this
 *                      run to the presence cycler (us7)
 *   op_read          — read 1password items from the service-account
 *                      vault (no tokens ever in the prompt; the op CLI
 *                      holds the service account env)
 *   session_query    — search previous dude2 run logs/sessions (the
 *                      "query the previous sessions" skill/api)
 *
 * communication with the dispatcher is deliberately file-based through
 * the dispatcher's own ingest dirs:
 *   replies  — $DUDE2_CONFIG_DIR/replies/<file>.json  {runId, text}
 *   queue.d  — $DUDE2_CONFIG_DIR/queue.d/<file>.json  {purpose, context}
 *   api      — $DUDE2_CONFIG_DIR/api/presence/<runId>.json {runId, text}
 * the dispatcher already polls queue.d + replies (phase 1) and gains a
 * reapPresence() pass (phase 2). this keeps the run <-> dispatcher
 * contract crash-safe with zero sockets, and e2e-testable by writing
 * the same files.
 *
 * loaded into every run when DUDE2_RUN_ID is set (see src/index.js);
 * the exported pure helpers are unit-testable without pi.
 */

import fs from "fs";
import path from "path";
import { execFile } from "child_process";

// ---------------------------------------------------------------- pure API

/** where the outbound-reply contract lives (dispatcher reapReplies). */
export function repliesDir(cfgDir) {
  return path.join(cfgDir, "replies");
}

/** where file-drop spawn requests live (dispatcher pollDrops). */
export function queueDropDir(cfgDir) {
  return path.join(cfgDir, "queue.d");
}

/** where run presence notes live (dispatcher reapPresence). */
export function presenceDir(cfgDir) {
  return path.join(cfgDir, "api", "presence");
}

/**
 * build the discord_send reply payload. numbered choices render as
 * "reply 1/2/3" lines under the text (us2: numbered reply options, not
 * buttons). pure; tests assert the shape.
 */
export function buildDiscordSend({ runId, text, choices = null, channelId = null }) {
  if (!text || typeof text !== "string") throw new Error("discord_send: text is required");
  let full = text;
  if (Array.isArray(choices) && choices.length > 0) {
    full += "\n\n" + choices.map((c, i) => `${i + 1}. ${c}`).join("\n") + "\n\n(reply with the number)";
  }
  return { runId, text: full, channelId };
}

/**
 * write a reply file the dispatcher forwards to discord. fs-injectable.
 */
export function fileDiscordSend(cfgDir, payload, fsMod = fs) {
  const dir = repliesDir(cfgDir);
  fsMod.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${payload.runId}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
  fsMod.writeFileSync(file, JSON.stringify(payload));
  return file;
}

/**
 * build + write a spawn_run file drop. the dispatcher's pollDrops
 * ingests {purpose, context} entries (type "purpose" when purpose set,
 * "prompt" otherwise). fs-injectable; returns the queue-entry shape it
 * will normalize to.
 */
export function fileSpawnRun(cfgDir, { purpose = null, context = "" }, fsMod = fs) {
  const dir = queueDropDir(cfgDir);
  fsMod.mkdirSync(dir, { recursive: true });
  const drop = purpose ? { purpose, context } : { context };
  const file = path.join(dir, `spawn-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
  fsMod.writeFileSync(file, JSON.stringify(drop));
  return { file, type: purpose ? "purpose" : "prompt", context };
}

/**
 * write a presence note for this run. the dispatcher folds it into the
 * registry and the presence cycler surfaces it on discord. fs-injectable.
 */
export function filePresenceNote(cfgDir, runId, text, fsMod = fs) {
  const dir = presenceDir(cfgDir);
  fsMod.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${runId}.json`);
  fsMod.writeFileSync(file, JSON.stringify({ runId, text }));
  return file;
}

/**
 * op_read via the op CLI. only `op://` item refs are allowed (the
 * service-account vault); everything else is rejected before exec.
 * execImpl injectable for tests.
 */
export function opRead(itemRef, execImpl = defaultExec) {
  if (!itemRef || typeof itemRef !== "string" || !itemRef.startsWith("op://")) {
    throw new Error('op_read: itemRef must be an "op://..." item reference');
  }
  return new Promise((resolve, reject) => {
    execImpl("op", ["read", itemRef], (err, stdout) => {
      if (err) reject(new Error(`op_read failed: ${err.message}`));
      else resolve(stdout);
    });
  });
}

function defaultExec(cmd, args, cb) {
  execFile(cmd, args, { timeout: 15_000 }, (err, stdout, stderr) =>
    cb(err, stdout || stderr),
  );
}

/**
 * session_query: search previous run logs + session jsonl files for
 * lines containing the query. searches, in order:
 *   - $DUDE2_LOG_DIR/runs/*.jsonl (unified run logs, phase 4)
 *   - $DUDE2_SESSION_DIR/<run>/*.jsonl (raw pi session transcripts)
 *   - $DUDE2_LOG_DIR/dispatcher.log
 * returns {source, file, line} snippets. fs-injectable, capped.
 */
export function sessionQuery(cfg, query, { limit = 20, fsMod = fs } = {}) {
  if (!query || typeof query !== "string") throw new Error("session_query: query is required");
  const q = query.toLowerCase();
  const hits = [];
  const files = [];
  const scan = (dir, source, recurse = false) => {
    try {
      for (const f of fsMod.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (recurse && fsMod.statSync(p).isDirectory()) scan(p, source);
        else if (f.endsWith(".jsonl")) files.push({ file: p, source });
      }
    } catch {
      /* missing dir is fine */
    }
  };
  scan(path.join(cfg.logDir, "runs"), "run-log");
  scan(cfg.sessionDir, "pi-session", true);
  files.push({ file: path.join(cfg.logDir, "dispatcher.log"), source: "dispatcher" });
  for (const { file, source } of files) {
    if (hits.length >= limit) break;
    let lines = [];
    try {
      lines = fsMod.readFileSync(file, "utf8").split("\n");
    } catch {
      continue;
    }
    for (const line of lines) {
      if (hits.length >= limit) break;
      if (line.toLowerCase().includes(q)) {
        hits.push({ source, file, line: line.slice(0, 500) });
      }
    }
  }
  return hits;
}

// ------------------------------------------------------------ pi extension

export default function register(pi) {
  const cfgDir = process.env.DUDE2_CONFIG_DIR;
  const runId = process.env.DUDE2_RUN_ID;
  if (!cfgDir || !runId) return; // only meaningful inside a dude2 run
  const cfg = {
    configDir: cfgDir,
    logDir: process.env.DUDE2_LOG_DIR || path.join(cfgDir, "logs"),
    sessionDir: process.env.DUDE2_SESSION_DIR || path.join(cfgDir, "sessions"),
  };

  pi.registerTool({
    name: "discord_send",
    label: "Discord Send",
    description:
      "send a message to discord from this run. options: choices (array of strings) renders numbered multiple-choice options the user can reply 1/2/3 to.",
    promptSnippet: "send discord messages (with optional numbered multiple-choice options)",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "message body (markdown)" },
        choices: { type: "array", items: { type: "string" }, description: "optional numbered options" },
        channelId: { type: "string", description: "optional explicit channel; defaults to this run's thread" },
      },
      required: ["text"],
    },
    async execute(_id, params) {
      const payload = buildDiscordSend({ runId, text: params.text, choices: params.choices ?? null, channelId: params.channelId ?? null });
      const file = fileDiscordSend(cfgDir, payload);
      return { content: [{ type: "text", text: `discord message queued (${path.basename(file)})` }], details: {} };
    },
  });

  pi.registerTool({
    name: "spawn_run",
    label: "Spawn Run",
    description:
      "spawn a new isolated dude2 agent run by enqueueing work with the dispatcher. pass either purpose (a named purpose like eng-orchestrator) or freeform context for a plain prompt. use for agent transitions and sub-agent stage runs.",
    promptSnippet: "spawn new isolated agent runs (sub-agents, stage dispatch, handoffs)",
    parameters: {
      type: "object",
      properties: {
        purpose: { type: "string", description: "optional purpose name for the new run" },
        context: { type: "string", description: "context/instructions handed to the new run (overshare — sub-runs only get this)" },
      },
      required: ["context"],
    },
    async execute(_id, params) {
      const res = fileSpawnRun(cfgDir, { purpose: params.purpose ?? null, context: params.context });
      return { content: [{ type: "text", text: `run enqueued via ${res.file} (type: ${res.type})` }], details: {} };
    },
  });

  pi.registerTool({
    name: "discord_presence",
    label: "Discord Presence",
    description:
      "set a whimsical one-line discord status note describing what this run is doing right now (shown by the presence cycler).",
    promptSnippet: "update the discord presence note for this run",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "one-line status in the dude voice" },
      },
      required: ["text"],
    },
    async execute(_id, params) {
      const file = filePresenceNote(cfgDir, runId, String(params.text).slice(0, 200));
      return { content: [{ type: "text", text: `presence note set (${path.basename(file)})` }], details: {} };
    },
  });

  pi.registerTool({
    name: "op_read",
    label: "1Password Read",
    description:
      "read a secret from the 1password service-account vault, e.g. 'op://AI/<item>/<field>'. never echo secret contents into your output unless essential.",
    promptSnippet: "read credentials from the 1password service account",
    parameters: {
      type: "object",
      properties: {
        itemRef: { type: "string", description: "op:// vault reference" },
      },
      required: ["itemRef"],
    },
    async execute(_id, params) {
      const value = await opRead(params.itemRef);
      return { content: [{ type: "text", text: value }], details: {} };
    },
  });

  pi.registerTool({
    name: "session_query",
    label: "Session Query",
    description:
      "search previous dude2 run logs and pi session transcripts for lines matching a query. use to recover context from earlier runs.",
    promptSnippet: "search previous run logs and session transcripts",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "text to search for (case-insensitive)" },
        limit: { type: "number", description: "max hits (default 20)" },
      },
      required: ["query"],
    },
    async execute(_id, params) {
      const hits = sessionQuery(cfg, params.query, { limit: params.limit ?? 20 });
      const body = hits.length
        ? hits.map((h) => `[${h.source}] ${h.line}`).join("\n")
        : "no matches found";
      return { content: [{ type: "text", text: body }], details: {} };
    },
  });
}
