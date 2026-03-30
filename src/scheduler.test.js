const fs = require("fs");
const path = require("path");

// Temp files for testing
const TEST_SCHEDULE = path.join(__dirname, "..", "test_schedule.json");
const TEST_LOG = path.join(__dirname, "..", "test_agent.log");

// Load the scheduler and override the file paths
const SCHEDULER = require("./scheduler");

// Mock file functions for testing
const originalLoadSchedule = SCHEDULER.loadSchedule;
const originalSaveSchedule = SCHEDULER.saveSchedule;
const originalLog = SCHEDULER.log;

function setupMocks() {
  // Override file paths in scheduler
  require.cache[require.resolve("./scheduler")].exports = createMockScheduler();
}

function createMockScheduler() {
  return {
    parseTimeString: SCHEDULER.parseTimeString,
    parseQuotaError: SCHEDULER.parseQuotaError,
    isQuotaError: SCHEDULER.isQuotaError,
    loadSchedule: () => {
      if (!fs.existsSync(TEST_SCHEDULE)) {
        return { paused: [], scheduled: [] };
      }
      try {
        return JSON.parse(fs.readFileSync(TEST_SCHEDULE, "utf8"));
      } catch (e) {
        return { paused: [], scheduled: [] };
      }
    },
    saveSchedule: (schedule) => {
      fs.writeFileSync(TEST_SCHEDULE, JSON.stringify(schedule, null, 2));
    },
    pauseTask: (task, errorInfo) => {
      const schedule = createMockScheduler().loadSchedule();
      const now = Date.now();
      const resumeAt = now + errorInfo.resetAfterMs;
      const pausedTask = {
        id: "test-id",
        task,
        pausedAt: now,
        resumeAt,
        errorInfo,
      };
      schedule.paused.push(pausedTask);
      createMockScheduler().saveSchedule(schedule);
      return pausedTask;
    },
    scheduleTask: (task, runAt, reason = "manual") => {
      const schedule = createMockScheduler().loadSchedule();
      const scheduledTask = {
        id: "test-id",
        task,
        scheduledAt: Date.now(),
        runAt,
        reason,
      };
      schedule.scheduled.push(scheduledTask);
      createMockScheduler().saveSchedule(schedule);
      return scheduledTask;
    },
    getReadyTasks: () => {
      const now = Date.now();
      const schedule = createMockScheduler().loadSchedule();
      const readyToResume = schedule.paused.filter((t) => t.resumeAt <= now);
      const readyToRun = schedule.scheduled.filter((t) => t.runAt <= now);
      return { paused: readyToResume, scheduled: readyToRun, schedule };
    },
    listPausedTasks: () => {
      const schedule = createMockScheduler().loadSchedule();
      const now = Date.now();
      return schedule.paused.map((t) => ({
        id: t.id,
        task: t.task,
        pausedAt: new Date(t.pausedAt).toLocaleString(),
        resumeAt: new Date(t.resumeAt).toLocaleString(),
        timeRemaining: Math.max(0, t.resumeAt - now),
      }));
    },
    listScheduledTasks: () => {
      const schedule = createMockScheduler().loadSchedule();
      const now = Date.now();
      return schedule.scheduled.map((t) => ({
        id: t.id,
        task: t.task,
        scheduledAt: new Date(t.scheduledAt).toLocaleString(),
        runAt: new Date(t.runAt).toLocaleString(),
        timeUntil: Math.max(0, t.runAt - now),
        reason: t.reason,
      }));
    },
    cancelPausedTask: (taskId) => {
      const schedule = createMockScheduler().loadSchedule();
      const index = schedule.paused.findIndex((t) => t.id === taskId);
      if (index !== -1) {
        const removed = schedule.paused.splice(index, 1)[0];
        createMockScheduler().saveSchedule(schedule);
        return removed;
      }
      return null;
    },
    cancelScheduledTask: (taskId) => {
      const schedule = createMockScheduler().loadSchedule();
      const index = schedule.scheduled.findIndex((t) => t.id === taskId);
      if (index !== -1) {
        const removed = schedule.scheduled.splice(index, 1)[0];
        createMockScheduler().saveSchedule(schedule);
        return removed;
      }
      return null;
    },
    suspendSession: (sessionId, reason = "awaiting feedback") => {
      const schedule = createMockScheduler().loadSchedule();
      schedule.suspendedSessions = schedule.suspendedSessions || [];
      const suspendedSession = {
        id: "test-suspended-id",
        sessionId,
        suspendedAt: Date.now(),
        reason,
      };
      schedule.suspendedSessions.push(suspendedSession);
      createMockScheduler().saveSchedule(schedule);
      return suspendedSession;
    },
    resumeSuspendedSession: (sessionId) => {
      const schedule = createMockScheduler().loadSchedule();
      const index = (schedule.suspendedSessions || []).findIndex(
        (s) => s.sessionId === sessionId
      );
      if (index !== -1) {
        const removed = schedule.suspendedSessions.splice(index, 1)[0];
        createMockScheduler().saveSchedule(schedule);
        return removed;
      }
      return null;
    },
    getReadySuspendedSessions: () => {
      const schedule = createMockScheduler().loadSchedule();
      return schedule.suspendedSessions || [];
    },
  };
}

// Clean up before tests
function cleanup() {
  if (fs.existsSync(TEST_SCHEDULE)) {
    fs.unlinkSync(TEST_SCHEDULE);
  }
  if (fs.existsSync(TEST_LOG)) {
    fs.unlinkSync(TEST_LOG);
  }
}

// Run tests
function runTests() {
  const scheduler = createMockScheduler();
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

  console.log("\nRunning tests...\n");

  // parseTimeString tests
  console.log("=== parseTimeString Tests ===");
  test("parses 3h50m3s", () => {
    assert(scheduler.parseTimeString("3h50m3s") === 13803000);
  });
  test("parses 24m26s", () => {
    assert(scheduler.parseTimeString("24m26s") === 1466000);
  });
  test("parses 1h0m0s", () => {
    assert(scheduler.parseTimeString("1h0m0s") === 3600000);
  });
  test("parses 1m0s", () => {
    assert(scheduler.parseTimeString("1m0s") === 60000);
  });
  test("parses 30s", () => {
    assert(scheduler.parseTimeString("30s") === 30000);
  });
  test("handles null input", () => {
    assert(scheduler.parseTimeString(null) === null);
  });

  // parseQuotaError tests
  console.log("\n=== parseQuotaError Tests ===");
  test("parses quota error message", () => {
    const msg = "Cloud Code Assist API error (429): You have exhausted your capacity on this model. Your quota will reset after 3h50m3s.";
    const result = scheduler.parseQuotaError(msg);
    assert(result.type === "quota_exhausted");
    assert(result.resetAfterMs === 13803000);
  });
  test("returns null for non-quota error", () => {
    const msg = "some other error";
    const result = scheduler.parseQuotaError(msg);
    assert(result === null);
  });
  test("parses error with short reset time", () => {
    const msg = "Cloud Code Assist API error (429): Your quota will reset after 5m0s";
    const result = scheduler.parseQuotaError(msg);
    assert(result.resetAfterMs === 300000);
  });

  // isQuotaError tests
  console.log("\n=== isQuotaError Tests ===");
  test("detects 429 with capacity message", () => {
    assert(scheduler.isQuotaError("429: You have exhausted your capacity") === true);
  });
  test("detects 429 with quota message", () => {
    assert(scheduler.isQuotaError("429: quota limit reached") === true);
  });
  test("returns false for normal error", () => {
    assert(scheduler.isQuotaError("normal error message") === false);
  });

  // Schedule operations
  console.log("\n=== Schedule Operations ===");
  test("pauses a task", () => {
    cleanup();
    const errorInfo = { type: "quota_exhausted", resetAfterMs: 60000, errorMessage: "429: quota" };
    const paused = scheduler.pauseTask("test task", errorInfo);
    assert(paused.task === "test task");
    assert(paused.resumeAt > Date.now());
    cleanup();
  });
  test("schedules a task", () => {
    cleanup();
    const runAt = Date.now() + 300000;
    const scheduled = scheduler.scheduleTask("scheduled task", runAt, "test");
    assert(scheduled.task === "scheduled task");
    assert(scheduled.runAt === runAt);
    assert(scheduled.reason === "test");
    cleanup();
  });
  test("lists paused tasks", () => {
    cleanup();
    const errorInfo = { type: "quota_exhausted", resetAfterMs: 60000, errorMessage: "429: quota" };
    scheduler.pauseTask("paused task", errorInfo);
    const paused = scheduler.listPausedTasks();
    assert(paused.length === 1);
    assert(paused[0].task === "paused task");
    cleanup();
  });
  test("lists scheduled tasks", () => {
    cleanup();
    const runAt = Date.now() + 300000;
    scheduler.scheduleTask("scheduled task", runAt, "test");
    const scheduled = scheduler.listScheduledTasks();
    assert(scheduled.length === 1);
    assert(scheduled[0].task === "scheduled task");
    cleanup();
  });
  test("cancels paused task", () => {
    cleanup();
    const errorInfo = { type: "quota_exhausted", resetAfterMs: 60000, errorMessage: "429: quota" };
    const paused = scheduler.pauseTask("test", errorInfo);
    const removed = scheduler.cancelPausedTask(paused.id);
    assert(removed.task === "test");
    assert(scheduler.listPausedTasks().length === 0);
    cleanup();
  });
  test("cancels scheduled task", () => {
    cleanup();
    const runAt = Date.now() + 300000;
    const scheduled = scheduler.scheduleTask("test", runAt, "test");
    const removed = scheduler.cancelScheduledTask(scheduled.id);
    assert(removed.task === "test");
    assert(scheduler.listScheduledTasks().length === 0);
    cleanup();
  });

  // Session suspension tests
  console.log("\n=== Session Suspension Tests ===");
  test("suspends a session", () => {
    cleanup();
    const suspended = scheduler.suspendSession("session-123", "awaiting feedback");
    assert(suspended.sessionId === "session-123");
    assert(suspended.reason === "awaiting feedback");
    cleanup();
  });

  test("resumes a suspended session", () => {
    cleanup();
    const suspended = scheduler.suspendSession("session-456", "awaiting feedback");
    const resumed = scheduler.resumeSuspendedSession("session-456");
    assert(resumed !== null);
    assert(resumed.sessionId === "session-456");
    assert(scheduler.getReadySuspendedSessions().length === 0);
    cleanup();
  });

  test("returns null for non-existent session resume", () => {
    cleanup();
    const resumed = scheduler.resumeSuspendedSession("nonexistent");
    assert(resumed === null);
    cleanup();
  });

  test("lists ready suspended sessions", () => {
    cleanup();
    scheduler.suspendSession("session-789", "awaiting feedback");
    const ready = scheduler.getReadySuspendedSessions();
    assert(ready.length === 1);
    assert(ready[0].sessionId === "session-789");
    cleanup();
  });

  console.log(`\n=== Results ===`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  cleanup();
}

runTests();
