#!/usr/bin/env node
/**
 * dude2-run — per-run entrypoint.
 *
 * one isolated agent run inside the dude2 runtime. delegates to the v1
 * `dude-agent --once` binary (all of v1's battle-tested hardening: tool
 * loop breaker, empty-response retry, stall watchdog, crash guard,
 * runtime cap, resume breadcrumbs) with the environment re-pointed at
 * dude2's own config/session/workspace paths, so dude2 shares ZERO
 * mutable state with a live v1 install.
 *
 * usage: dude2-run --once [--purpose <name>] [--context "<text>"]
 *        (args are passed straight through to the agent binary)
 */

import { spawn } from "child_process";
import path from "path";
import { loadConfig, assertIsolation } from "./config.js";
import { writeCompactionSettings } from "./compaction-extension.js";
import { defaultV1AgentPath } from "./run-executor.js";

const cfg = loadConfig();
assertIsolation(cfg);

// per-run session subdir keyed by DUDE2_RUN_ID (set by the dispatcher) or
// a standalone-invoke fallback so manual runs still stay isolated
const runId = process.env.DUDE2_RUN_ID || `manual-${process.pid}`;
const sessionDir = path.join(cfg.sessionDir, runId);
process.env.PI_SESSION_DIR = sessionDir;
process.env.DUDE_CONFIG_DIR = cfg.configDir;
process.env.DUDE_WORKING_DIR = cfg.workspace;
// v1 agent reads OBSIDIAN_DIR at module load — never let it be undefined
process.env.OBSIDIAN_DIR = process.env.OBSIDIAN_DIR || cfg.obsidianDir;

const impl = cfg.runImpl || defaultV1AgentPath();
const args = [...process.argv.slice(2)];

// phase 3: auto-compaction tuned for glm-5.3 — pi reads compaction
// settings from <project-dir>/.pi/settings.json and the run's project
// dir IS the workspace (DUDE_WORKING_DIR). best-effort: a settings
// write failure must never block the run.
try {
  const file = writeCompactionSettings(cfg, cfg.workspace);
  console.log(`[dude2-run ${runId}] compaction settings -> ${file}`);
} catch (e) {
  console.error(`[dude2-run ${runId}] compaction settings write failed (non-fatal): ${e?.message || e}`);
}

console.log(`[dude2-run ${runId}] impl=${path.basename(impl)} args=${args.join(" ")}`);

const child = spawn(process.execPath, [impl, ...args], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
