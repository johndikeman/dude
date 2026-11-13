/**
 * regression test (2026-11-13 live incident): dude2 runs exited 0 with good
 * replies in the transcript, but nothing ever posted back to discord.
 *
 * root cause: src/index.js constructs its own DefaultResourceLoader and
 * passes it to pi's createAgentSession — but pi only calls loader.reload()
 * when it *constructs* the loader itself (core/sdk.js:76-78). with a
 * caller-supplied loader, getExtensions() returns the initial empty
 * extensionsResult forever, so the dude2 api-extension (discord_send,
 * spawn_run, op_read, ...) never registers and replies are stranded in the
 * session transcript. skills suffer the same silent drop.
 *
 * this test pins the contract index.js now relies on: a loader built the
 * way index.js builds it (additionalExtensionPaths → api-extension) yields
 * NO extensions before reload(), and the full tool set after reload().
 */

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "url";
import { DefaultResourceLoader, createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

const apiExtensionPath = fileURLToPath(new URL("../src/dude2/api-extension.js", import.meta.url));
const cwd = fileURLToPath(new URL("..", import.meta.url));

function makeLoader() {
  return new DefaultResourceLoader({
    cwd,
    agentDir: fileURLToPath(new URL("../test/agent-dir", import.meta.url)),
    additionalExtensionPaths: [apiExtensionPath],
  });
}

// the extension's register() bails without these; mirror run-executor's env
process.env.DUDE2_RUN_ID = process.env.DUDE2_RUN_ID || "run-test-loader";
process.env.DUDE2_CONFIG_DIR = process.env.DUDE2_CONFIG_DIR || "/tmp";

test("without reload(), a caller-supplied loader registers no extensions (the 2026-11-13 bug)", () => {
  const loader = makeLoader();
  const exts = loader.getExtensions();
  assert.equal(exts.extensions.length, 0, "stale empty extensionsResult before reload()");
});

test("after reload(), the api-extension registers and its tools reach the session", async () => {
  const loader = makeLoader();
  await loader.reload();

  const exts = loader.getExtensions();
  assert.equal(exts.errors.length, 0, `extension load errors: ${JSON.stringify(exts.errors)}`);
  const apiExt = exts.extensions.find((e) => e.resolvedPath === apiExtensionPath);
  assert.ok(apiExt, "api-extension loaded");
  const toolNames = [...apiExt.tools.keys()];
  for (const expected of ["discord_send", "spawn_run", "discord_presence", "op_read", "session_query"]) {
    assert.ok(toolNames.includes(expected), `tool registered: ${expected}`);
  }
});

test("createAgentSession wires reloaded extension tools into the session tool registry", async (t) => {
  const sessionDir = `${process.env.TMPDIR || "/tmp"}/dude2-loader-test-sessions`;
  const loader = makeLoader();
  await loader.reload();
  const sessionManager = SessionManager.create(cwd, sessionDir);
  const { session } = await createAgentSession({
    cwd,
    resourceLoader: loader,
    sessionManager,
    model: { id: "z-ai/glm-5.3", provider: "openrouter" },
    thinkingLevel: "low",
  });
  const registryNames = [...session._toolRegistry.keys()];
  assert.ok(registryNames.includes("discord_send"), `discord_send active in registry: ${registryNames.join(",")}`);
});