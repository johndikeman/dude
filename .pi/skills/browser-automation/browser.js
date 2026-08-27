#!/usr/bin/env node
// browser.js — CLI for interactive browser automation from the agent.
//
// usage:
//   browser.js start [--fresh]                 launch persistent session
//   browser.js stop                            kill session
//   browser.js goto <url>
//   browser.js snapshot                        indexed interactive-element dump
//   browser.js click <ref|selector>
//   browser.js clickxy <x> <y>                 raw coordinate click (captchas)
//   browser.js type <ref|selector> <text> [--no-clear]
//   browser.js press <key>                     e.g. Enter, Tab, Escape
//   browser.js select <ref|selector> <value|label>
//   browser.js upload <ref|selector> <file...>
//   browser.js screenshot [path]               png path is printed on success
//   browser.js scroll [up|down] [px]
//   browser.js eval "<js>"
//
// A daemon owns the headless chromium; each command is sent to it over a
// loopback HTTP API, so cookies/js state persist across commands.

import { runDaemon, startDaemon, stopSession, waitForApi, callDaemon } from "./lib/browser-session.js";

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === "_daemon") {
    await runDaemon();
    return new Promise(() => {}); // daemon must live forever
  }

  switch (cmd) {
    case "start": {
      const trace = (m) => process.env.DEBUG_TRACE && console.error(`[trace] ${m}`);
      trace("start: stopping old");
      if (args.includes("--fresh")) await stopSession();
      trace("start: probing existing");

      // reuse an already-running session if healthy
      try {
        const st = await callDaemon("noop").then(() => true);
        if (st) {
          console.log("browser session already running");
          return;
        }
      } catch {}

      trace("start: spawning daemon");
      startDaemon();
      trace("start: waiting for api");
      await waitForApi();
      trace("start: ready");
      console.log("browser session running");
      return;
    }
    case "stop": {
      const ok = await stopSession();
      console.log(ok ? "session stopped" : "no active session");
      return;
    }
    default:
      break;
  }

  if (!cmd) {
    console.error("usage: browser.js <command> [args]  (see file header)");
    process.exit(2);
  }

  const argList = args.filter((a) => a !== "--no-clear");
  switch (cmd) {
    case "type":
      args.noClear = args.includes("--no-clear");
      break;
    default:
      break;
  }

  let out;
  try {
    switch (cmd) {
      case "goto":
        out = await callDaemon("goto", [argList[0]]);
        break;
      case "snapshot":
        out = await callDaemon("snapshot", []);
        break;
      case "click":
        out = await callDaemon("click", [argList[0]]);
        break;
      case "clickxy":
        out = await callDaemon("clickxy", [argList[0], argList[1]]);
        break;
      case "type": {
        const noClear = args.includes("--no-clear");
        out = await callDaemon("type", [argList[0], argList.slice(1).join(" "), noClear]);
        break;
      }
      case "press":
        out = await callDaemon("press", [argList[0]]);
        break;
      case "select":
        out = await callDaemon("select", [argList[0], argList.slice(1).join(" ")]);
        break;
      case "upload":
        out = await callDaemon("upload", argList);
        break;
      case "screenshot":
        out = await callDaemon("screenshot", [argList[0]]);
        break;
      case "scroll":
        out = await callDaemon("scroll", [argList[0] || "down", argList[1]]);
        break;
      case "eval":
        out = await callDaemon("eval", [argList[0]]);
        break;
      default:
        console.error(`unknown command: ${cmd}`);
        process.exit(2);
    }
    console.log(out);
  } catch (err) {
    console.error("error:", err.message);
    process.exit(1);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("error:", err.message);
    process.exit(1);
  },
);
