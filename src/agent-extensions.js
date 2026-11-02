import fs from "fs";
import path from "path";

/**
 * global pi extensions dir (~/.pi/agent/extensions).
 *
 * pi's DefaultResourceLoader only auto-discovers extensions in
 * <agentDir>/extensions and <cwd>/.pi/extensions. real agent runs set
 * agentDir=DUDE_CONFIG_DIR (~/.config/dude), so the nix-managed
 * ~/.pi/agent/extensions dir was never scanned — the langfuse trace
 * exporter and tasks-wait-state-sync silently never ran in production
 * sessions (found 2026-11-02: traces existed only from manual CLI runs).
 *
 * the returned absolute paths get appended to ADDITIONAL_EXTENSION_PATHS
 * in src/index.js so every session (CLI or library) loads them.
 *
 * injectable fs/path args keep this testable.
 */
export function globalPiExtensionPaths({
  dir = path.join(process.env.HOME || "", ".pi", "agent", "extensions"),
  fsMod = fs,
} = {}) {
  try {
    return fsMod
      .readdirSync(dir)
      .map((f) => path.join(dir, f))
      .filter((p) => {
        if (!/\.(js|mjs|ts)$/.test(p) || path.basename(p).startsWith(".")) return false;
        try { return fsMod.statSync(p).isFile(); } catch { return false; }
      });
  } catch {
    return []; // dir missing entirely (e.g. bare dev box) — not an error
  }
}
