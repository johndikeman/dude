/**
 * tests for the purpose registry (src/purpose.js)
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { listPurposes, loadPurpose, parsePurposeArgs } from "./src/purpose.js";

test("loadPurpose returns null for default (no name)", async () => {
  assert.equal(await loadPurpose(null), null);
  assert.equal(await loadPurpose(undefined), null);
});

test("loadPurpose loads the prediction-markets purpose", async () => {
  const p = await loadPurpose("prediction-markets");
  assert.equal(p.name, "prediction-markets");
  assert.ok(p.prompt.length > 50);
  assert.deepEqual(p.skillPaths, ["prediction-markets"]);
});

test("loadPurpose throws for unknown purpose", async () => {
  await assert.rejects(() => loadPurpose("does-not-exist"), /unknown purpose/);
});

test("loadPurpose throws for purpose file missing prompt export", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "purpose-"));
  fs.writeFileSync(path.join(dir, "bad.js"), "export default { nope: 1 };");
  await assert.rejects(
    () => loadPurpose("bad", dir),
    /must export \{ prompt/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadPurpose works with a module exporting check-style named default", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "purpose-"));
  fs.writeFileSync(
    path.join(dir, "ok.js"),
    "export default { description: 'd', prompt: 'do the thing' };",
  );
  const p = await loadPurpose("ok", dir);
  assert.equal(p.prompt, "do the thing");
  assert.deepEqual(p.skillPaths, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("listPurposes lists .js files without extension", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "purpose-"));
  fs.writeFileSync(path.join(dir, "a.js"), "");
  fs.writeFileSync(path.join(dir, "b.js"), "");
  fs.writeFileSync(path.join(dir, "c.txt"), "");
  assert.deepEqual(listPurposes(dir), ["a", "b"]);
  assert.deepEqual(listPurposes(path.join(dir, "missing")), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("parsePurposeArgs extracts --purpose and --context", () => {
  const argv = ["node", "dude-agent", "--once", "--purpose", "pm", "--context", "hi there"];
  assert.deepEqual(parsePurposeArgs(argv), { purpose: "pm", context: "hi there" });
  assert.deepEqual(parsePurposeArgs(["node", "dude-agent", "--once"]), {
    purpose: null,
    context: null,
  });
  // context with no following value is ignored
  assert.deepEqual(parsePurposeArgs(["node", "x", "--context"]), {
    purpose: null,
    context: null,
  });
});
