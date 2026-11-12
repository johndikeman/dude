#!/usr/bin/env node
/**
 * dude2 dispatcher — the one long-running spine of dude v2.
 *
 * owns:
 *   - the generic input queue (sqlite): discord messages, wait-runner
 *     one-shots, file drops, api calls — all normalized to queue entries
 *   - the agent registry: spawns `dude2-run` child processes per entry,
 *     tracks them, publishes agents-state.json (presence + orchestrator)
 *   - discord presence cycling (whimsical status from the registry)
 *   - concurrency cap (default 3 concurrent runs)
 *
 * discord replies to the bot in a run's thread re-prompt that same
 * session via the runId mapping in the queue (us2.1: context lines
 * carry "run: <runId>").
 *
 * injectable seams for the e2e harness:
 *   - gateway factory (createGateway) — the real discord.js client or a
 *     recording stub
 *   - spawnRun — the child process spawner or a stub
 *
 * usage: dude2-dispatch [--once]   (--once: drain the queue then exit;
 *                                   default: run the poll loop forever)
 */

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { loadConfig, assertIsolation } from "./config.js";
import {
  openQueue,
  enqueue,
  claimNext,
  complete,
  requeue,
  dedupeKeyFor,
  latestRunForChannel,
  attachRun,
} from "./queue.js";
import {
  registerRun,
  markExited,
  canSpawn,
  pruneFinished,
  newRunId,
} from "./registry.js";
import { buildRunInvocation } from "./run-executor.js";
import { startPresenceCycler } from "./presence.js";

const cfg = loadConfig();
assertIsolation(cfg);

/** single log line with a source tag, to file + stdout (sourced logging,
 * phase-1 form; full jsonl/logging system is phase 4) */
export function logLine(cfg2, source, msg) {
  const line = `[${new Date().toISOString()}] [${source}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(cfg2.logDir, { recursive: true });
    fs.appendFileSync(path.join(cfg2.logDir, "dispatcher.log"), line + "\n");
  } catch {
    /* best-effort */
  }
}

const log = (source, msg) => logLine(cfg, source, msg);

/**
 * ingest a raw discord message object into the queue. exported for the
 * gateway + e2e. discord replies in a run's thread map back to that
 * runId (us2.1); everything else is a fresh prompt.
 */
export function ingestDiscordMessage(db, { channelId, content, messageId, threadToRun = {} }) {
  const existingRun = threadToRun[channelId] ?? null;
  const entry = {
    source: "discord",
    type: existingRun ? "callback" : "prompt",
    context: existingRun ? `run: ${existingRun}\n${content}` : content,
    runId: existingRun,
    channelId,
    dedupeKey: dedupeKeyFor("discord", messageId),
  };
  return enqueue(db, entry);
}

/**
 * ingest a file drop (v1 pending-stage.json pattern): {"project": "...",
 * "stage": "..."} or a freeform {context, purpose} object. the file is
 * consumed (deleted) after ingest.
 */
export function ingestFileDrop(db, filePath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    log("dispatcher", `file drop ${filePath} unreadable: ${e?.message || e}`);
    return null;
  }
  const entry = {
    source: "file-drop",
    type: raw.purpose ? "purpose" : "prompt",
    context: raw.context ?? JSON.stringify(raw),
  };
  const res = enqueue(db, entry);
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* already gone */
  }
  log("dispatcher", `file drop ingested: ${filePath} -> queue #${res.id}`);
  return res;
}

/**
 * the dispatcher core. wires queue -> registry -> spawn, with injectable
 * gateway + spawner so e2e runs it against mocks.
 */
export function createDispatcher({
  config = cfg,
  db,
  spawnRunImpl = spawnRun,
  gateway = null, // { sendReply({channelId, text}) } when discord is wired
} = {}) {
  const threadToRun = {}; // channelId -> runId (us2.1 mapping)
  const runsByQueue = {}; // queueId -> {runId, child}
  const channelByRun = {}; // runId -> channelId (reply forwarding)

  function spawnRun(entry) {
    const runId = entry.runId || newRunId();
    if (!canSpawn(config.agentsStateFile, config.maxConcurrentRuns)) {
      log("dispatcher", `concurrency cap (${config.maxConcurrentRuns}) reached; requeueing #${entry.id}`);
      return null;
    }
    attachRun(db, entry.id, runId);
    registerRun(config.agentsStateFile, {
      runId,
      purpose: entry.type === "purpose" ? (entry.context?.match(/^purpose:\s*(\S+)/m)?.[1] ?? null) : null,
      model: config.model,
    });
    const inv = buildRunInvocation(config, { ...entry, runId });
    log("dispatcher", `dispatching queue #${entry.id} as run ${runId} (${inv.args.join(" ")})`);
    const child = spawnRunImpl(inv, { runId, entry });
    if (child == null) return null;
    runsByQueue[entry.id] = { runId, child };
    // discord prompt inputs remember their channel so replies re-prompt
    // the same session (us2.1) and outbound replies land in-thread
    if (entry.channelId) {
      threadToRun[entry.channelId] = runId;
      channelByRun[runId] = entry.channelId;
    }
    return { runId, child };
  }

  function drainOne() {
    const entry = claimNext(db);
    if (!entry) return false;
    const spawned = spawnRun(entry);
    if (!spawned) {
      // cap hit: put it back for the next tick (not lost, just deferred)
      requeue(db, entry.id);
      return false;
    }
    return true;
  }

  function reapFinished() {
    for (const [queueId, { runId, child }] of Object.entries(runsByQueue)) {
      if (!child || child.finished) continue;
      if (child.exitCode !== null || child.signalCode) {
        child.finished = true;
        markExited(config.agentsStateFile, runId, child.exitCode ?? 1);
        complete(db, Number(queueId), `run ${runId} exited ${child.exitCode ?? "signal " + child.signalCode}`);
        delete runsByQueue[queueId];
        log("dispatcher", `run ${runId} finished (exit ${child.exitCode ?? child.signalCode})`);
      }
    }
    pruneFinished(config.agentsStateFile);
  }

  /**
   * forward run-filed outbound replies to discord. a run (or its api
   * extension, phase 2) drops $DUDE2_CONFIG_DIR/replies/<runId>.json =
   * {runId, text}; the dispatcher — which owns the discord client —
   * sends it into the run's channel/thread and consumes the file.
   */
  function reapReplies() {
    const repliesDir = path.join(config.configDir, "replies");
    let files = [];
    try {
      files = fs.readdirSync(repliesDir).filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }
    for (const f of files) {
      const full = path.join(repliesDir, f);
      try {
        const reply = JSON.parse(fs.readFileSync(full, "utf8"));
        const channelId = reply.channelId || channelByRun[reply.runId];
        if (gateway?.sendReply && channelId && reply.text) {
          gateway.sendReply({ channelId, text: reply.text, runId: reply.runId });
          log("dispatcher", `reply forwarded for run ${reply.runId} -> channel ${channelId}`);
        } else if (!channelId || !reply.text) {
          log("dispatcher", `malformed reply file ${f} (dropped)`);
        } else if (!gateway?.sendReply) {
          log("dispatcher", `reply for run ${reply.runId} held (no gateway)`);
          continue; // keep the file; retry when the gateway is up
        }
        fs.unlinkSync(full);
      } catch (e) {
        log("dispatcher", `reply file ${f} unreadable: ${e?.message || e}`);
      }
    }
  }

  return {
    drainOne,
    reapFinished,
    reapReplies,
    spawnRun,
    threadToRun,
    ingestDiscordMessage: (msg) => {
      // us2.1: a reply in a channel that maps to a live run is a callback
      // to THAT run, not a new prompt
      const existingRun = threadToRun[msg.channelId] ?? null;
      return ingestDiscordMessage(db, {
        ...msg,
        threadToRun: existingRun ? { [msg.channelId]: existingRun } : {},
      });
    },
    ingestFileDrop: (f) => ingestFileDrop(db, f),
  };
}

/** the real spawner: detached child per run (cgroup caps land in phase 1 nix). */
export function spawnRun(inv) {
  const child = spawn(inv.cmd, inv.args, {
    env: inv.env,
    stdio: "ignore",
    detached: false,
  });
  child.unref?.();
  return child;
}

// ---- CLI entry -----------------------------------------------------------

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith("dispatcher.js");

if (isMain) {
  const once = process.argv.includes("--once");
  fs.mkdirSync(cfg.configDir, { recursive: true });
  fs.mkdirSync(cfg.sessionDir, { recursive: true });
  const db = openQueue(cfg.queueDb);

  // optional discord gateway (real token or none in tests). created BEFORE
  // the dispatcher so its sendReply hook can be injected; message ingest
  // goes straight into the queue (module fn), so no circular dependency.
  let gateway = null;
  let stopPresence = () => {};
  if (cfg.discordToken && !once) {
    try {
      const { createGateway } = await import("./discord-gateway.js");
      const gw = await createGateway(cfg, {
        onMessage: (msg) => {
          // us2.1: a reply inside a run's thread re-prompts that same run
          const existingRun = latestRunForChannel(db, msg.channelId);
          ingestDiscordMessage(db, { ...msg, threadToRun: existingRun ? { [msg.channelId]: existingRun } : {} });
        },
      });
      gateway = gw;
      stopPresence = startPresenceCycler({
        client: gw.client,
        stateFile: cfg.agentsStateFile,
        log: (m) => log("presence", m),
      });
      log("dispatcher", "discord gateway connected");
    } catch (e) {
      // graceful: presence/discord must never block dispatching
      log("dispatcher", `discord gateway unavailable (non-fatal): ${e?.message || e}`);
    }
  }

  const dispatcher = createDispatcher({ config: cfg, db, gateway });

  const tick = () => {
    reapAndDrain();
  };
  function reapAndDrain() {
    dispatcher.reapFinished();
    dispatcher.reapReplies();
    // keep draining while under the cap and entries remain
    while (dispatcher.drainOne()) {
      if (!canSpawn(cfg.agentsStateFile, cfg.maxConcurrentRuns)) break;
    }
  }

  // file-drop dir ($DUDE2_CONFIG_DIR/queue.d/*.json) — the pending-stage
  // pattern, generalized
  const dropDir = path.join(cfg.configDir, "queue.d");
  const pollDrops = () => {
    try {
      for (const f of fs.readdirSync(dropDir)) {
        if (f.endsWith(".json")) dispatcher.ingestFileDrop(path.join(dropDir, f));
      }
    } catch {
      /* dir may not exist yet */
    }
  };

  if (once) {
    pollDrops();
    reapAndDrain();
    // give spawned children a moment, then exit (they are tracked in the
    // registry; a later --once tick reaps them)
    setTimeout(() => process.exit(0), 500).unref?.();
  } else {
    log("dispatcher", `dude2 dispatcher up (config=${cfg.configDir}, cap=${cfg.maxConcurrentRuns})`);
    const timer = setInterval(tick, cfg.pollIntervalMs);
    timer.unref?.();
    const dropTimer = setInterval(pollDrops, cfg.pollIntervalMs);
    dropTimer.unref?.();
    process.on("SIGTERM", () => {
      stopPresence();
      process.exit(0);
    });
  }
}
