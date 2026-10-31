import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { syncTasksWaitState, tasksFile } from "./tasks-wait-state.js";

/**
 * tasks-wait-state-sync — pi extension that keeps wait-state.json's
 * `ai-tasks` hash current after the agent edits the task file itself.
 *
 * hooks tool_execution_end for the edit/write tools; when the tool's
 * target is the task file, the checklist hash is recomputed and written to
 * the wait state file so the next wait tick doesn't see a "new" checklist
 * and re-fire the agent (self-trigger cascade). errors are logged to
 * stderr and never thrown into the agent loop.
 */
export default function (pi: ExtensionAPI) {
  pi.on("tool_execution_end", async (event: any) => {
    try {
      const name = event?.toolName;
      if (name !== "edit" && name !== "write") return;
      // both tools take a `path` param; defensive across shapes
      const p = event?.args?.path ?? event?.input?.path;
      if (!p) return;
      if (String(p) !== tasksFile()) return;
      const r = syncTasksWaitState();
      if (r.updated) {
        console.error(`[tasks-wait-state] synced ai-tasks hash after ${name} of ${p}`);
      } else {
        console.error(`[tasks-wait-state] task file unreadable after ${name} of ${p}; nothing to sync`);
      }
    } catch (err: any) {
      console.error(`[tasks-wait-state] sync failed: ${err?.message ?? err}`);
    }
  });
}
