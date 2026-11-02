import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { globalPiExtensionPaths } from "./src/agent-extensions.js";

test("globalPiExtensionPaths lists only script files, skipping dotfiles", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ext-"));
  fs.writeFileSync(path.join(dir, "pi-langfuse-traces.ts"), "x");
  fs.writeFileSync(path.join(dir, "tasks-wait-state.js"), "x");
  fs.writeFileSync(path.join(dir, "notes.md"), "x");
  fs.writeFileSync(path.join(dir, ".hidden.js"), "x");
  fs.mkdirSync(path.join(dir, "subdir.js")); // dirs are not extensions
  const paths = globalPiExtensionPaths({ dir });
  assert.deepEqual(paths, [
    path.join(dir, "pi-langfuse-traces.ts"),
    path.join(dir, "tasks-wait-state.js"),
  ]);
});

test("globalPiExtensionPaths returns [] when dir is missing", () => {
  assert.deepEqual(globalPiExtensionPaths({ dir: "/nonexistent-dir-xyz" }), []);
});
