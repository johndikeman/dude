/**
 * dude2 run executor — how the dispatcher turns a queue entry into a
 * spawned, isolated agent run.
 *
 * phase 1 reuses v1's battle-tested agent binary (`dude-agent --once`)
 * verbatim: the hardening (tool-loop breaker, empty-response retry, stall
 * watchdog, crash guard, runtime cap, resume breadcrumbs) already lives
 * there and is proven. dude2-run wraps it with env-driven dude2 paths
 * (DUDE_CONFIG_DIR -> dude2 config dir, PI_SESSION_DIR -> per-run subdir)
 * so isolation comes from the environment, not a fork of the code.
 *
 * the executor is injectable (config.runImpl) so the e2e harness can swap
 * in a stub run impl and exercise the full dispatcher flow without a
 * model provider.
 */

import path from "path";

/**
 * build (cmd, env, opts) for spawning one run.
 * @param {object} cfg  dude2 config (loadConfig())
 * @param {object} entry claimed queue entry {id, source, type, context, runId}
 * @param {object} [opts] { runImplPath: string|null }
 */
export function buildRunInvocation(cfg, entry, opts = {}) {
  const impl = opts.runImplPath ?? cfg.runImpl ?? defaultV1AgentPath();
  const purpose = entry.type === "purpose" ? purposeFromEntry(entry) : null;
  const runSessionDir = path.join(cfg.sessionDir, entry.runId);

  const args = ["--once"];
  if (purpose) args.push("--purpose", purpose);
  if (entry.context) args.push("--context", entry.context);

  const env = {
    ...process.env,
    // v1 binary reads these; point every one of them at dude2 state
    DUDE_CONFIG_DIR: cfg.configDir,
    DUDE_WORKING_DIR: cfg.workspace,
    PI_SESSION_DIR: runSessionDir,
    // v1 index.js does path.join(process.env.OBSIDIAN_DIR, ...) at module
    // load — undefined here crashed every run (see task doc 2026-11-13)
    OBSIDIAN_DIR: cfg.obsidianDir,
    DUDE_MODEL: cfg.model,
    DUDE_MODEL_PROVIDER: cfg.modelProvider,
    DUDE_FALLBACK_MODEL: cfg.fallbackModel,
    DUDE_FALLBACK_MODEL_PROVIDER: cfg.fallbackModelProvider,
    DUDE_MAX_RUNTIME_MS: String(cfg.maxRuntimeMs),
    // dude2 markers the run can see for its own bookkeeping
    DUDE2_RUN_ID: entry.runId,
    DUDE2_QUEUE_ID: String(entry.id),
    DUDE2_CONFIG_DIR: cfg.configDir,
    DUDE2_SESSION_DIR: cfg.sessionDir,
  };
  // last-run file must also be per-config-dir (v1 default is $DUDE_CONFIG_DIR
  // so this is already implied, but pin it explicitly for clarity)
  env.DUDE_LAST_RUN_FILE = path.join(cfg.configDir, "last-run.json");

  return { cmd: process.execPath, args: [impl, ...args], env, runSessionDir, purpose };
}

function purposeFromEntry(entry) {
  // queue entries may carry an explicit purpose marker in context lines
  // ("purpose: <name>") or use entry.runId-prefixed naming; default to the
  // generic prompt flow (no purpose flag) for plain prompts.
  const m = entry.context?.match(/^purpose:\s*(\S+)/m);
  return m ? m[1] : null;
}

/** resolve the bundled v1 dude-agent entry script (same package). */
export function defaultV1AgentPath() {
  // src/dude2/run-executor.js -> package root/src/index.js
  return new URL("../index.js", import.meta.url).pathname;
}

/**
 * is this process's run finished? reads the run result file the v1 agent
 * writes on exit (src/run-result.js convention) — the dispatcher polls
 * child exit directly, so this is only a helper for tests/inspection.
 */
export function resultFilePath(cfg, runId) {
  return path.join(cfg.configDir, "last-run.json");
}
