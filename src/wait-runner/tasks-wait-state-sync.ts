import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { syncAllIndexWaitState, INDEX_FILES, tasksFile } from "./tasks-wait-state.js";

/**
 * tasks-wait-state-sync — pi extension that keeps wait-state.json's
 * index-file checklist hashes current after the agent edits those files
 * itself. tracks every vault index in INDEX_FILES (ai-tasks, ai-projects).
 *
 * hooks tool_execution_end for the edit/write tools; when the tool's
 * target is a tracked index file, its checklist hash is recomputed and
 * written to the wait state file so the next wait tick doesn't see a
 * "new" checklist and re-fire the agent (self-trigger cascade). errors
 * are logged to stderr and never thrown into the agent loop.
 */
export default function (pi: ExtensionAPI) {
  pi.on("tool_execution_end", async (event: any) => {
    try {
      const name = event?.toolName;
      if (name !== "edit" && name !== "write") return;
      // both tools take a `path` param; defensive across shapes
      const p = event?.args?.path ?? event?.input?.path;
      if (!p) return;
      const tracked = INDEX_FILES.some(({ file }) => String(p) === file());
      if (!tracked) return;
      const results = syncAllIndexWaitState();
      const mine = results.find((r) => r.file === String(p));
      if (mine?.updated) {
        console.error(`[tasks-wait-state] synced ${mine.key} hash after ${name} of ${p}`);
      } else {
        console.error(`[tasks-wait-state] index file unreadable after ${name} of ${p}; nothing to sync`);
      }
    } catch (err: any) {
      console.error(`[tasks-wait-state] sync failed: ${err?.message ?? err}`);
    }
  });
}

// keep the old named export referenced so tree-shaking doesn't complain and
// direct imports (tests) still work.
export { tasksFile };
