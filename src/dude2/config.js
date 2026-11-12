/**
 * dude2 config — env-driven state paths (the nix rule).
 *
 * every dude2 state file path is overridable via env vars so the nix
 * homeManagerModule (services.dude2-agent) is the single source of truth
 * for where everything lives. defaults NEVER point at v1's paths: dude2
 * and dude v1 must coexist with zero shared mutable state.
 *
 * REQUIRED by the project objective (verbatim): "ensure 100% embed it
 * into the bones of this project (add to AGENTS.md) that we need to have
 * all state file paths tracked/configurable with nix."
 */

import path from "path";

/** every state path dude2 owns, as { envVar, default } */
export const PATH_SPECS = {
  configDir: { envVar: "DUDE2_CONFIG_DIR" },
  workspace: { envVar: "DUDE2_WORKSPACE" },
  sessionDir: { envVar: "DUDE2_SESSION_DIR" },
  queueDb: { envVar: "DUDE2_QUEUE_DB" },
  agentsStateFile: { envVar: "DUDE2_AGENTS_STATE_FILE" },
  logDir: { envVar: "DUDE2_LOG_DIR" },
  discordSessionMap: { envVar: "DUDE2_DISCORD_SESSION_MAP" },
};

/** default config dir for a given HOME (deliberately distinct from v1) */
export function defaultConfigDir(env = process.env) {
  return path.join(env.HOME || "/tmp", ".config/dude2");
}

export const DEFAULT_CONFIG_DIR = defaultConfigDir();

/**
 * load the dude2 config from `env` (defaults to process.env).
 * every path env-overridable; every default under the dude2 config dir.
 */
export function loadConfig(env = process.env) {
  const configDir = env.DUDE2_CONFIG_DIR || defaultConfigDir(env);
  const under = (...parts) => path.join(configDir, ...parts);
  const cfg = {
    configDir,
    workspace: env.DUDE2_WORKSPACE || path.join(env.HOME || "/tmp", "dude2-workspace"),
    sessionDir: env.DUDE2_SESSION_DIR || under("sessions"),
    queueDb: env.DUDE2_QUEUE_DB || under("queue.db"),
    agentsStateFile: env.DUDE2_AGENTS_STATE_FILE || under("agents-state.json"),
    logDir: env.DUDE2_LOG_DIR || under("logs"),
    discordSessionMap: env.DUDE2_DISCORD_SESSION_MAP || under("discord-message-sessions.json"),
    // agent runtime knobs
    model: env.DUDE2_MODEL || "z-ai/glm-5.3",
    modelProvider: env.DUDE2_MODEL_PROVIDER || "openrouter",
    fallbackModel: env.DUDE2_FALLBACK_MODEL || "openrouter/free",
    fallbackModelProvider: env.DUDE2_FALLBACK_MODEL_PROVIDER || "openrouter",
    maxConcurrentRuns: positiveInt(env.DUDE2_MAX_CONCURRENT_RUNS, 3),
    maxRuntimeMs: nonNegativeInt(env.DUDE2_MAX_RUNTIME_MS, 4 * 60 * 60 * 1000),
    discordToken: env.DUDE2_DISCORD_TOKEN || null,
    pollIntervalMs: positiveInt(env.DUDE2_POLL_INTERVAL_MS, 2000),
    // the v1 agent binary dude2-run delegates to (reuses the battle-tested
    // hardening verbatim; injectable for e2e tests)
    runImpl: env.DUDE2_RUN_IMPL || null,
    // compaction (phase 3): tuned for glm-5.3's window by default; the
    // run writes these into the workspace .pi/settings.json pi reads
    compactionEnabled: env.DUDE2_COMPACTION_ENABLED !== "0",
    compactionReserveTokens: positiveInt(env.DUDE2_COMPACTION_RESERVE_TOKENS, 24_000),
    compactionKeepRecentTokens: positiveInt(env.DUDE2_COMPACTION_KEEP_RECENT_TOKENS, 32_000),
    // log export (phase 4): supabase first, disk-local fallback
    exportSupabaseUrl: env.DUDE2_EXPORT_SUPABASE_URL || null,
    exportSupabaseKey: env.DUDE2_EXPORT_SUPABASE_KEY || null,
    exportSupabaseTable: env.DUDE2_EXPORT_SUPABASE_TABLE || "langfuse_traces",
    exportDir: env.DUDE2_EXPORT_DIR || null, // resolved from logDir below
  };
  // defaults that derive from configDir
  if (!env.DUDE2_WORKSPACE) cfg.workspace = path.join(configDir, "workspace");
  if (!cfg.exportDir) cfg.exportDir = path.join(cfg.logDir, "export");
  return cfg;
}

function positiveInt(raw, dflt) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

function nonNegativeInt(raw, dflt) {
  if (raw == null || raw === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}

/**
 * the run-alongside-v1 invariant: dude2 must never touch v1's mutable
 * state. throws when any resolved dude2 path collides with v1's known
 * state locations (config dir, workspace, session dir, queue/state files).
 */
export function assertIsolation(cfg, env = process.env) {
  const v1Paths = new Set(
    [
      env.HOME ? path.join(env.HOME, ".config/dude") : null,
      env.DUDE_CONFIG_DIR,
      env.HOME ? path.join(env.HOME, "dude-workspace") : null,
      env.DUDE_WORKING_DIR,
      env.PI_SESSION_DIR,
      env.HOME ? path.join(env.HOME, ".config/dude/queue.db") : null,
      env.HOME ? path.join(env.HOME, ".config/dude/agents-state.json") : null,
    ].filter(Boolean),
  );
  const mine = [cfg.configDir, cfg.workspace, cfg.sessionDir, cfg.queueDb, cfg.agentsStateFile];
  for (const p of mine) {
    for (const v of v1Paths) {
      if (p === v || p.startsWith(v + path.sep) || v.startsWith(p + path.sep)) {
        throw new Error(
          `dude2/v1 state collision: "${p}" overlaps v1 path "${v}" — dude2 must never share mutable state with v1`,
        );
      }
    }
  }
  return true;
}
