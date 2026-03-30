const fs = require("fs");
const path = require("path");

const CONFIG_DIR = process.env.DUDE_CONFIG_DIR || process.cwd();
const SCHEDULE_FILE = path.join(CONFIG_DIR, "schedule.json");
const LOG_FILE = path.join(CONFIG_DIR, "agent.log");

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (e) {}
}

// Parse time strings like "3h50m3s" or "24m26s" or "1h0m0s" into milliseconds
function parseTimeString(timeStr) {
  if (!timeStr) return null;

  const hoursMatch = timeStr.match(/(\d+)h/);
  const minutesMatch = timeStr.match(/(\d+)m/);
  const secondsMatch = timeStr.match(/(\d+)s/);

  const hours = hoursMatch ? parseInt(hoursMatch[1], 10) : 0;
  const minutes = minutesMatch ? parseInt(minutesMatch[1], 10) : 0;
  const seconds = secondsMatch ? parseInt(secondsMatch[1], 10) : 0;

  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

// Parse quota error message and extract reset time
function parseQuotaError(errorMessage) {
  // Pattern: "Cloud Code Assist API error (429): You have exhausted your capacity on this model. Your quota will reset after 3h50m3s."
  // Also handles cases where no time is specified
  const timeMatch = errorMessage.match(/quota will reset after ([0-9]+h)?([0-9]+m)?([0-9]+s)?/i);
  const quotaExhaustedMatch = errorMessage.match(/you have exhausted your capacity|quota exhausted|rate limit exceeded/i);

  if (timeMatch) {
    const timeStr = timeMatch[0].replace("quota will reset after ", "");
    const ms = parseTimeString(timeStr);
    return {
      type: "quota_exhausted",
      resetAfterMs: ms,
      errorMessage,
    };
  }

  // If we found a quota exhaustion error but no time is specified, use a default
  if (quotaExhaustedMatch) {
    // Default to 1 hour (3600000 ms) when no reset time is specified
    return {
      type: "quota_exhausted",
      resetAfterMs: 3600000, // 1 hour default
      errorMessage,
    };
  }

  return null;
}

// Check if an error message is a quota error
function isQuotaError(output) {
  // Must have 429 status code and be an actual error message
  // This is more specific to avoid false positives from text about quota handling
  const has429 = output.includes("429");
  const hasCapacityError = output.includes("exhausted your capacity");
  const hasQuotaReset = output.includes("quota will reset") || output.includes("Quota exhausted") || output.includes("quota limit reached");
  const hasRateLimit = output.includes("rate limit exceeded");
  
  // Check if it's likely an actual error (has 429 AND one of the error messages)
  if (has429 && (hasCapacityError || hasQuotaReset || hasRateLimit)) {
    return true;
  }
  
  // Also match common quota error patterns without 429 (some APIs return different codes)
  const hasClearQuotaError = (
    (hasCapacityError || hasQuotaReset) && 
    output.includes("error") && 
    output.includes("capacity")
  );
  
  return hasClearQuotaError;
}

// Load scheduled tasks from file
function loadSchedule() {
  if (!fs.existsSync(SCHEDULE_FILE)) {
    return { paused: [], scheduled: [] };
  }
  try {
    const content = fs.readFileSync(SCHEDULE_FILE, "utf8");
    return JSON.parse(content);
  } catch (e) {
    log(`Error loading schedule: ${e.message}`);
    return { paused: [], scheduled: [] };
  }
}

// Save schedule to file
function saveSchedule(schedule) {
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2));
  log(`Schedule saved: ${schedule.paused.length} paused tasks, ${schedule.scheduled.length} scheduled tasks`);
}

// Pause a task due to quota error
function pauseTask(task, errorInfo) {
  const schedule = loadSchedule();
  const now = Date.now();
  const resumeAt = now + errorInfo.resetAfterMs;

  const pausedTask = {
    id: Date.now().toString(),
    task,
    pausedAt: now,
    resumeAt,
    errorInfo,
  };

  schedule.paused.push(pausedTask);
  saveSchedule(schedule);
  return pausedTask;
}

// Schedule a task to run at a specific time
function scheduleTask(task, runAt, reason = "manual") {
  const schedule = loadSchedule();

  const scheduledTask = {
    id: Date.now().toString(),
    task,
    scheduledAt: Date.now(),
    runAt,
    reason,
  };

  schedule.scheduled.push(scheduledTask);
  saveSchedule(schedule);
  return scheduledTask;
}

// Get tasks that are ready to resume/run
function getReadyTasks() {
  const now = Date.now();
  const schedule = loadSchedule();

  // Tasks ready to resume (past resume time)
  const readyToResume = schedule.paused.filter((t) => t.resumeAt <= now);

  // Tasks ready to run (past scheduled time)
  const readyToRun = schedule.scheduled.filter((t) => t.runAt <= now);

  return { paused: readyToResume, scheduled: readyToRun, schedule };
}

// Remove completed tasks from schedule
function removeCompletedTasks(taskIds) {
  const schedule = loadSchedule();
  schedule.paused = schedule.paused.filter((t) => !taskIds.includes(t.id));
  schedule.scheduled = schedule.scheduled.filter((t) => !taskIds.includes(t.id));
  saveSchedule(schedule);
}

// Get list of paused tasks
function listPausedTasks() {
  const schedule = loadSchedule();
  const now = Date.now();

  return schedule.paused.map((t) => {
    const timeRemaining = Math.max(0, t.resumeAt - now);
    return {
      id: t.id,
      task: t.task,
      pausedAt: new Date(t.pausedAt).toLocaleString(),
      resumeAt: new Date(t.resumeAt).toLocaleString(),
      timeRemaining,
      errorMessage: t.errorInfo?.errorMessage || "Unknown error",
      errorType: t.errorInfo?.type || "unknown",
    };
  });
}

// Get error information for a specific paused task
function getPausedTaskError(taskId) {
  const schedule = loadSchedule();
  const task = schedule.paused.find((t) => t.id === taskId);
  return task?.errorInfo || null;
}

// Get list of scheduled tasks
function listScheduledTasks() {
  const schedule = loadSchedule();
  const now = Date.now();

  return schedule.scheduled.map((t) => {
    const timeUntil = Math.max(0, t.runAt - now);
    return {
      id: t.id,
      task: t.task,
      scheduledAt: new Date(t.scheduledAt).toLocaleString(),
      runAt: new Date(t.runAt).toLocaleString(),
      timeUntil,
      reason: t.reason,
    };
  });
}

// Cancel a paused task
function cancelPausedTask(taskId) {
  const schedule = loadSchedule();
  const index = schedule.paused.findIndex((t) => t.id === taskId);
  if (index !== -1) {
    const removed = schedule.paused.splice(index, 1)[0];
    saveSchedule(schedule);
    return removed;
  }
  return null;
}

// Cancel a scheduled task
function cancelScheduledTask(taskId) {
  const schedule = loadSchedule();
  const index = schedule.scheduled.findIndex((t) => t.id === taskId);
  if (index !== -1) {
    const removed = schedule.scheduled.splice(index, 1)[0];
    saveSchedule(schedule);
    return removed;
  }
  return null;
}

// Suspend a session for later resumption with feedback
function suspendSession(sessionId, reason = "awaiting feedback") {
  const schedule = loadSchedule();

  const suspendedSession = {
    id: Date.now().toString(),
    sessionId,
    suspendedAt: Date.now(),
    reason,
  };

  schedule.suspendedSessions = schedule.suspendedSessions || [];
  schedule.suspendedSessions.push(suspendedSession);
  saveSchedule(schedule);
  return suspendedSession;
}

// Resume a suspended session
function resumeSuspendedSession(sessionId) {
  const schedule = loadSchedule();
  const index = (schedule.suspendedSessions || []).findIndex(
    (s) => s.sessionId === sessionId,
  );
  if (index !== -1) {
    const removed = schedule.suspendedSessions.splice(index, 1)[0];
    saveSchedule(schedule);
    return removed;
  }
  return null;
}

// Check for suspended sessions that are ready
function getReadySuspendedSessions() {
  const schedule = loadSchedule();
  return schedule.suspendedSessions || [];
}

module.exports = {
  parseTimeString,
  parseQuotaError,
  isQuotaError,
  loadSchedule,
  saveSchedule,
  pauseTask,
  scheduleTask,
  getReadyTasks,
  removeCompletedTasks,
  listPausedTasks,
  listScheduledTasks,
  cancelPausedTask,
  cancelScheduledTask,
  getPausedTaskError,
  suspendSession,
  resumeSuspendedSession,
  getReadySuspendedSessions,
};
