/**
 * dude2 discord presence — whimsical status cycling from agents-state.json.
 *
 * the dispatcher (or its injected stub gateway in e2e) calls
 * startPresenceCycler(); every tick it reads the agent registry and sets
 * a "Playing <text>" activity describing what the agents are up to. all
 * updates are best-effort: a discord hiccup must never crash dispatch.
 *
 * us7: "watch the discord status cycle through whimsical summaries of
 * what the currently-running agents are doing."
 */

import fs from "fs";
import { readState } from "./registry.js";

/** base presence texts when agents are idle/running (dude voice). */
export const IDLE_LINES = [
  "watching the queue",
  "loitering near ~/.config/dude2",
  "waiting for john's next whim",
];

/** build one presence line from the registry state. */
export function presenceText(state) {
  const running = (state?.runs ?? []).filter((r) => r.status === "running");
  if (running.length === 0) return pick(IDLE_LINES);
  const names = running.map((r) => r.purpose || r.runId);
  if (running.length === 1) return `herding 1 agent (${names[0]})`;
  return `herding ${running.length} agents (${names.slice(0, 2).join(", ")}${running.length > 2 ? ", ..." : ""})`;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)] ?? arr[0];
}

/**
 * start cycling presence from the state file. returns stop().
 * client: { user: { setActivity(text, opts) } } — discord.js client or
 * an e2e stub. never throws.
 */
export function startPresenceCycler({
  client,
  stateFile,
  intervalMs = 30_000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  fsMod = fs,
  log = () => {},
} = {}) {
  if (!client || !stateFile) return () => {};
  let stopped = false;

  const apply = () => {
    if (stopped) return;
    try {
      const state = readState(stateFile, fsMod);
      const text = presenceText(state);
      client.user?.setActivity?.(text, { type: 0 /* Playing */ });
      log(`presence: "${text}"`);
    } catch (e) {
      log(`presence update failed (non-fatal): ${e?.message || e}`);
    }
  };
  apply();
  const timer = setIntervalFn(apply, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  return () => {
    stopped = true;
    clearIntervalFn(timer);
  };
}
