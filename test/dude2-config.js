/**
 * tests for src/dude2/config.js — the nix rule: every state path
 * env-configurable, defaults never v1's paths, isolation invariant.
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "os";
import path from "path";
import { loadConfig, assertIsolation, DEFAULT_CONFIG_DIR } from "./../src/dude2/config.js";

const CLEAN_ENV = { HOME: "/home/tester" };

test("loadConfig defaults live under ~/.config/dude2, never v1's dir", () => {
  const cfg = loadConfig(CLEAN_ENV);
  assert.equal(cfg.configDir, "/home/tester/.config/dude2");
  assert.ok(cfg.queueDb.startsWith("/home/tester/.config/dude2/"));
  assert.ok(cfg.agentsStateFile.startsWith("/home/tester/.config/dude2/"));
  assert.ok(cfg.sessionDir.startsWith("/home/tester/.config/dude2/"));
  assert.ok(cfg.workspace.startsWith("/home/tester/.config/dude2/"));
  assert.notEqual(cfg.configDir, "/home/tester/.config/dude");
});

test("every state path is env-overridable (nix source-of-truth rule)", () => {
  const env = {
    ...CLEAN_ENV,
    DUDE2_CONFIG_DIR: "/x/cfg",
    DUDE2_WORKSPACE: "/x/ws",
    DUDE2_SESSION_DIR: "/x/sess",
    DUDE2_QUEUE_DB: "/x/q.db",
    DUDE2_AGENTS_STATE_FILE: "/x/state.json",
    DUDE2_LOG_DIR: "/x/logs",
    DUDE2_DISCORD_SESSION_MAP: "/x/map.json",
  };
  const cfg = loadConfig(env);
  assert.equal(cfg.configDir, "/x/cfg");
  assert.equal(cfg.workspace, "/x/ws");
  assert.equal(cfg.sessionDir, "/x/sess");
  assert.equal(cfg.queueDb, "/x/q.db");
  assert.equal(cfg.agentsStateFile, "/x/state.json");
  assert.equal(cfg.logDir, "/x/logs");
  assert.equal(cfg.discordSessionMap, "/x/map.json");
});

test("runtime knobs: concurrency cap default 3, env override; runtime cap", () => {
  assert.equal(loadConfig(CLEAN_ENV).maxConcurrentRuns, 3);
  assert.equal(loadConfig({ ...CLEAN_ENV, DUDE2_MAX_CONCURRENT_RUNS: "5" }).maxConcurrentRuns, 5);
  // garbage falls back to default, never 0/infinite
  assert.equal(loadConfig({ ...CLEAN_ENV, DUDE2_MAX_CONCURRENT_RUNS: "banana" }).maxConcurrentRuns, 3);
  assert.equal(loadConfig(CLEAN_ENV).maxRuntimeMs, 4 * 60 * 60 * 1000);
  assert.equal(loadConfig({ ...CLEAN_ENV, DUDE2_MAX_RUNTIME_MS: "0" }).maxRuntimeMs, 0);
});

test("assertIsolation throws when dude2 paths collide with v1 paths", () => {
  const env = { ...CLEAN_ENV, DUDE2_CONFIG_DIR: "/home/tester/.config/dude" };
  const cfg = loadConfig(env);
  assert.throws(() => assertIsolation(cfg, env), /collision/);
});

test("assertIsolation throws on a dude2 subdir nested inside v1 state", () => {
  const env = { ...CLEAN_ENV, DUDE2_WORKSPACE: "/home/tester/dude-workspace/dude2" };
  const cfg = loadConfig(env);
  assert.throws(() => assertIsolation(cfg, env), /collision/);
});

test("assertIsolation passes for the stock dude2 layout", () => {
  const cfg = loadConfig(CLEAN_ENV);
  assert.equal(assertIsolation(cfg), true);
});

test("default config dir does not collide with v1 on this machine", () => {
  const cfg = loadConfig();
  assert.equal(assertIsolation(cfg), true);
});
