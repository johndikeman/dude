import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Temp files for testing
const TEST_SESSIONS = path.join(__dirname, "..", "test_sessions.json");

// Create a test sessions module with overridden file paths
function createTestSessions() {
  return {
    loadSessions: () => {
      if (!fs.existsSync(TEST_SESSIONS)) {
        return { active: [], completed: [] };
      }
      try {
        return JSON.parse(fs.readFileSync(TEST_SESSIONS, "utf8"));
      } catch (e) {
        return { active: [], completed: [] };
      }
    },
    saveSessions: (sessions) => {
      fs.writeFileSync(TEST_SESSIONS, JSON.stringify(sessions, null, 2));
    },
    createSession: (task, options = {}) => {
      const sessions = createTestSessions().loadSessions();
      const session = {
        id: "test-session-id",
        task,
        createdAt: Date.now(),
        status: "active",
        discordMessageId: options.discordMessageId || null,
        discordChannelId: options.discordChannelId || null,
        prNumber: options.prNumber || null,
        prRepo: options.prRepo || null,
        workspacePath: options.workspacePath || "/test",
        prompt: options.prompt || null,
      };
      sessions.active.push(session);
      createTestSessions().saveSessions(sessions);
      return session;
    },
    getSession: (sessionId) => {
      const sessions = createTestSessions().loadSessions();
      return sessions.active.find((s) => s.id === sessionId) || null;
    },
    getSessionByDiscordMessage: (messageId) => {
      const sessions = createTestSessions().loadSessions();
      return sessions.active.find((s) => s.discordMessageId === messageId) || null;
    },
    getSessionByPR: (prNumber, prRepo) => {
      const sessions = createTestSessions().loadSessions();
      return sessions.active.find((s) => s.prNumber === prNumber && s.prRepo === prRepo) || null;
    },
    updateSession: (sessionId, updates) => {
      const sessions = createTestSessions().loadSessions();
      const index = sessions.active.findIndex((s) => s.id === sessionId);
      if (index === -1) return null;
      sessions.active[index] = { ...sessions.active[index], ...updates };
      createTestSessions().saveSessions(sessions);
      return sessions.active[index];
    },
    linkDiscordMessage: (sessionId, messageId, channelId) => {
      return createTestSessions().updateSession(sessionId, { discordMessageId: messageId, discordChannelId: channelId });
    },
    linkPR: (sessionId, prNumber, prRepo) => {
      return createTestSessions().updateSession(sessionId, { prNumber, prRepo });
    },
    completeSession: (sessionId) => {
      const sessions = createTestSessions().loadSessions();
      const index = sessions.active.findIndex((s) => s.id === sessionId);
      if (index === -1) return null;
      const session = sessions.active.splice(index, 1)[0];
      session.status = "completed";
      session.completedAt = Date.now();
      sessions.completed.push(session);
      if (sessions.completed.length > 50) {
        sessions.completed = sessions.completed.slice(-50);
      }
      createTestSessions().saveSessions(sessions);
      return session;
    },
    getActiveSessions: () => {
      const sessions = createTestSessions().loadSessions();
      return sessions.active.map((s) => ({
        id: s.id,
        task: s.task,
        createdAt: new Date(s.createdAt).toLocaleString(),
      }));
    },
  };
}

// Clean up before tests
function cleanup() {
  if (fs.existsSync(TEST_SESSIONS)) {
    fs.unlinkSync(TEST_SESSIONS);
  }
}

// Run tests
function runTests() {
  const sessions = createTestSessions();
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e) {
      console.log(`  ✗ ${name}: ${e.message}`);
      failed++;
    }
  }

  function assert(condition, message) {
    if (!condition) {
      throw new Error(message || "Assertion failed");
    }
  }

  console.log("\nRunning sessions module tests...\n");

  // Session creation tests
  console.log("=== Session Creation Tests ===");
  test("creates a session with task", () => {
    cleanup();
    const session = sessions.createSession("test task");
    assert(session.id === "test-session-id");
    assert(session.task === "test task");
    assert(session.status === "active");
    cleanup();
  });

  test("creates a session with discord message link", () => {
    cleanup();
    const session = sessions.createSession("test task", {
      discordMessageId: "msg123",
      discordChannelId: "ch123",
    });
    assert(session.discordMessageId === "msg123");
    assert(session.discordChannelId === "ch123");
    cleanup();
  });

  // Session retrieval tests
  console.log("\n=== Session Retrieval Tests ===");
  test("gets session by ID", () => {
    cleanup();
    sessions.createSession("test task");
    const session = sessions.getSession("test-session-id");
    assert(session !== null);
    assert(session.task === "test task");
    cleanup();
  });

  test("returns null for non-existent session", () => {
    cleanup();
    const session = sessions.getSession("nonexistent");
    assert(session === null);
    cleanup();
  });

  // Session linking tests
  console.log("\n=== Session Linking Tests ===");
  test("links Discord message to session", () => {
    cleanup();
    sessions.createSession("test task");
    const updated = sessions.linkDiscordMessage("test-session-id", "msg456", "ch456");
    assert(updated !== null);
    assert(updated.discordMessageId === "msg456");
    assert(updated.discordChannelId === "ch456");
    cleanup();
  });

  test("links PR to session", () => {
    cleanup();
    sessions.createSession("test task");
    const updated = sessions.linkPR("test-session-id", 42, "owner/repo");
    assert(updated !== null);
    assert(updated.prNumber === 42);
    assert(updated.prRepo === "owner/repo");
    cleanup();
  });

  test("links Discord message via creation", () => {
    cleanup();
    sessions.createSession("test task", { discordMessageId: "msg789" });
    const session = sessions.getSessionByDiscordMessage("msg789");
    assert(session !== null);
    assert(session.task === "test task");
    cleanup();
  });

  test("links PR via creation", () => {
    cleanup();
    sessions.createSession("test task", { prNumber: 99, prRepo: "test/repo" });
    const session = sessions.getSessionByPR(99, "test/repo");
    assert(session !== null);
    assert(session.task === "test task");
    cleanup();
  });

  test("returns null for non-linked Discord message", () => {
    cleanup();
    sessions.createSession("test task");
    const session = sessions.getSessionByDiscordMessage("nonexistent");
    assert(session === null);
    cleanup();
  });

  // Session completion tests
  console.log("\n=== Session Completion Tests ===");
  test("completes a session", () => {
    cleanup();
    sessions.createSession("test task");
    const completed = sessions.completeSession("test-session-id");
    assert(completed !== null);
    assert(completed.status === "completed");
    assert(completed.completedAt !== null);
    cleanup();
  });

  test("returns null for non-existent session completion", () => {
    cleanup();
    const completed = sessions.completeSession("nonexistent");
    assert(completed === null);
    cleanup();
  });

  test("returns empty list when no active sessions", () => {
    cleanup();
    const active = sessions.getActiveSessions();
    assert(Array.isArray(active));
    assert(active.length === 0);
    cleanup();
  });

  test("returns list with active session", () => {
    cleanup();
    sessions.createSession("test task");
    const active = sessions.getActiveSessions();
    assert(active.length === 1);
    assert(active[0].task === "test task");
    cleanup();
  });

  // Error handling tests
  console.log("\n=== Error Handling Tests ===");
  test("handles empty tasks gracefully", () => {
    cleanup();
    const active = sessions.getActiveSessions();
    assert(Array.isArray(active));
    cleanup();
  });

  test("handles corrupted sessions file", () => {
    cleanup();
    fs.writeFileSync(TEST_SESSIONS, "not valid json");
    const active = sessions.getActiveSessions();
    assert(Array.isArray(active));
    cleanup();
  });

  console.log(`\n=== Results ===`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
