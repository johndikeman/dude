
import fs from "fs/promises";
import path from "path";
import assert from "assert";

/**
 * Re-implementation of tasks-safeguard logic in JS for testing
 */
function isValidEdit(oldText, newText) {
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

function isOnlyNewTasks(text) {
  const lines = text.split("\n").filter(l => l.trim() !== "");
  return lines.every(line => line.trim().startsWith("- [ ]"));
}

function isValidWrite(oldContent, newContent) {
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

// Tests
async function runTests() {
  console.log("Running Tasks Safeguard Tests...");

  // Test isValidEdit
  console.log("Testing isValidEdit...");
  assert(isValidEdit("- [ ] Task 1", "- [x] Task 1"), "Crossing off task should be allowed");
  assert(isValidEdit("- [ ] Task 1\n", "- [ ] Task 1\n- [ ] Task 2\n"), "Adding task at the end should be allowed");
  assert(isValidEdit("- [ ] Task 1\n", "- [ ] Task 2\n- [ ] Task 1\n"), "Adding task at the beginning should be allowed");
  assert(!isValidEdit("- [ ] Task 1", "Something else"), "Random edit should be blocked");
  assert(!isValidEdit("- [ ] Task 1", ""), "Deleting task should be blocked");

  // Test isValidWrite
  console.log("Testing isValidWrite...");
  const oldContent = "# Pending Tasks\n- [ ] Task 1\n- [ ] Task 2";
  assert(isValidWrite(oldContent, "# Pending Tasks\n- [x] Task 1\n- [ ] Task 2"), "Crossing off task 1 should be allowed");
  assert(isValidWrite(oldContent, "# Pending Tasks\n- [ ] Task 1\n- [x] Task 2"), "Crossing off task 2 should be allowed");
  assert(isValidWrite(oldContent, "# Pending Tasks\n- [ ] Task 1\n- [ ] Task 2\n- [ ] Task 3"), "Adding task 3 at the end should be allowed");
  assert(isValidWrite(oldContent, "# Pending Tasks\n- [ ] Task 3\n- [ ] Task 1\n- [ ] Task 2"), "Adding task 3 at the beginning should be allowed");
  assert(isValidWrite(oldContent, "# Pending Tasks\n- [x] Task 1\n- [x] Task 2\n- [ ] Task 3"), "Crossing off all and adding new should be allowed");
  
  assert(!isValidWrite(oldContent, "# Pending Tasks\n- [ ] Task 2"), "Deleting task 1 should be blocked");
  assert(!isValidWrite(oldContent, "# Pending Tasks\n- [ ] Task 1"), "Deleting task 2 should be blocked");
  assert(!isValidWrite(oldContent, "# Pending Tasks\nSomething else"), "Random write should be blocked");

  console.log("All Tasks Safeguard Tests PASSED!");
}

runTests().catch(e => {
  console.error("Test FAILED!");
  console.error(e);
  process.exit(1);
});
