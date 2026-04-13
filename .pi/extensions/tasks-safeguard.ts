import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Tasks Safeguard Extension
 *
 * Prevents accidental or malicious overwriting of the tasks.md file.
 * Only allows adding tasks on a new line or crossing off an existing task.
 */
export default function (pi: ExtensionAPI) {
  const TASKS_PATH = "/home/ubuntu/.config/dude/tasks.md";

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      const command = event.input.command as string;
      if (command.includes(TASKS_PATH) || command.includes("tasks.md")) {
        return { block: true, reason: "Direct modification of tasks.md via bash is not allowed. Use the 'edit' or 'write' tools instead, or 'read' to view it." };
      }
    }

    if (event.toolName !== "write" && event.toolName !== "edit") {
      return undefined;
    }

    const path = resolve(ctx.cwd, event.input.path as string);
    if (path !== TASKS_PATH) {
      return undefined;
    }

    if (isToolCallEventType("write", event)) {
      const newContent = event.input.content as string;
      let oldContent = "";
      try {
        oldContent = await readFile(TASKS_PATH, "utf8");
      } catch (e) {
        // If file doesn't exist, we allow initial write
        return undefined;
      }

      if (!isValidWrite(oldContent, newContent)) {
        return { block: true, reason: "Invalid modification to tasks.md. Only adding tasks or crossing them off is allowed." };
      }
    }

    if (isToolCallEventType("edit", event)) {
      const edits = event.input.edits as { oldText: string; newText: string }[];
      for (const edit of edits) {
        if (!isValidEdit(edit.oldText, edit.newText)) {
          return { block: true, reason: `Invalid edit in tasks.md: "${edit.oldText}" -> "${edit.newText}". Only crossing off tasks or adding new ones is allowed.` };
        }
      }
    }

    return undefined;
  });

  function isValidEdit(oldText: string, newText: string): boolean {
    // Check if it's crossing off a task: [ ] -> [x]
    if (oldText.includes("[ ]") && newText === oldText.replace("[ ]", "[x]")) {
      return true;
    }
    
    // Check if it's adding a new task.
    // If newText contains oldText and the rest is just new tasks:
    if (newText.startsWith(oldText)) {
        const added = newText.slice(oldText.length);
        if (isOnlyNewTasks(added)) return true;
    }
    if (newText.endsWith(oldText)) {
        const added = newText.slice(0, newText.length - oldText.length);
        if (isOnlyNewTasks(added)) return true;
    }

    return false;
  }

  function isOnlyNewTasks(text: string): boolean {
    const lines = text.split("\n").filter(l => l.trim() !== "");
    return lines.every(line => line.trim().startsWith("- [ ]"));
  }

  function isValidWrite(oldContent: string, newContent: string): boolean {
    const oldLines = oldContent.split("\n").map(l => l.trim()).filter(l => l !== "");
    const newLines = newContent.split("\n").map(l => l.trim()).filter(l => l !== "");

    // Every old line must still be present in the same order (or crossed off)
    let oldIdx = 0;
    for (let newIdx = 0; newIdx < newLines.length; newIdx++) {
      if (oldIdx < oldLines.length) {
        const oldLine = oldLines[oldIdx];
        const newLine = newLines[newIdx];
        
        if (oldLine === newLine) {
          oldIdx++;
          continue;
        }
        
        // Check if it was crossed off
        if (oldLine.includes("[ ]") && newLine === oldLine.replace("[ ]", "[x]")) {
          oldIdx++;
          continue;
        }

        // If it's not the current old line, it must be a new task
        if (newLine.startsWith("- [ ]")) {
          continue;
        }
        
        return false; // Nonsense detected
      } else {
        // All old lines accounted for, rest must be new tasks
        const newLine = newLines[newIdx];
        if (!newLine.startsWith("- [ ]") && newLine !== "" && !newLine.startsWith("#")) {
            return false;
        }
      }
    }
    
    return oldIdx === oldLines.length;
  }
}
