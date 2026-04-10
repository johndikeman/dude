import fs from "fs";
import path from "path";

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
export function parseTimeString(timeStr) {
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
export function parseQuotaError(errorMessage) {
  // Pattern: "Cloud Code Assist API error (429): You have exhausted your capacity on this model. Your quota will reset after 3h50m3s."
  // Also handles cases where no time is specified
  const timeMatch = errorMessage.match(/quota will reset after ([0-9]+h)?([0-9]+m)?([0-9]+s)?/i);
  const quotaExhaustedMatch = errorMessage.match(/you have exhausted your capacity|quota exhausted|rate limit exceeded|no capacity available/i);

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
export function isQuotaError(output) {
  const lowerOutput = output.toLowerCase();
  // Must have 429 status code and be an actual error message
  // This is more specific to avoid false positives from text about quota handling
  const has429 = output.includes("429");
  const hasCapacityError = lowerOutput.includes("exhausted your capacity") || lowerOutput.includes("no capacity available");
  const hasQuotaReset = lowerOutput.includes("quota will reset") || lowerOutput.includes("quota exhausted") || lowerOutput.includes("quota limit reached");
  const hasRateLimit = lowerOutput.includes("rate limit exceeded");
  
  // Check if it's likely an actual error (has 429 AND one of the error messages)
  if (has429 && (hasCapacityError || hasQuotaReset || hasRateLimit)) {
    return true;
  }
  
  // Also match common quota error patterns without 429 (some APIs return different codes)
  const hasClearQuotaError = (
    (hasCapacityError || hasQuotaReset) && 
    lowerOutput.includes("error") && 
    lowerOutput.includes("capacity")
  );
  
  return hasClearQuotaError;
}

// Load scheduled tasks from file
export function loadSchedule() {
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
export function saveSchedule(schedule) {
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2));
  log(`Schedule saved: ${schedule.paused.length} paused tasks, ${schedule.scheduled.length} scheduled tasks`);
}

// Check if a task is already in the paused list
function isTaskAlreadyPaused(schedule, task) {
  return schedule.paused.some((t) => t.task === task);
}

// Check if a task is already in the scheduled list with a specific reason
function isTaskAlreadyScheduled(schedule, task, reason = null) {
  const tasks = schedule.scheduled.filter((t) => t.task === task);
  if (!reason) return tasks.length > 0;
  return tasks.some((t) => t.reason === reason);
}

// Pause a task due to quota error
export function pauseTask(task, errorInfo) {
  const schedule = loadSchedule();
  
  // Check if task is already paused
  if (isTaskAlreadyPaused(schedule, task)) {
    log(`Task "${task}" is already paused, skipping duplicate pause`);
    return schedule.paused.find((t) => t.task === task);
  }
  
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
export function scheduleTask(task, runAt, reason = "manual") {
  const schedule = loadSchedule();

  // Check if task is already scheduled with the same reason
  if (isTaskAlreadyScheduled(schedule, task, reason)) {
    log(`Task "${task}" is already scheduled with reason "${reason}", skipping duplicate`);
    return schedule.scheduled.find((t) => t.task === task && t.reason === reason);
  }

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
export function getReadyTasks() {
  const now = Date.now();
  const schedule = loadSchedule();

  // Tasks ready to resume (past resume time)
  const readyToResume = schedule.paused.filter((t) => t.resumeAt <= now);

  // Tasks ready to run (past scheduled time)
  const readyToRun = schedule.scheduled.filter((t) => t.runAt <= now);

  return { paused: readyToResume, scheduled: readyToRun, schedule };
}

// Remove completed tasks from schedule
export function removeCompletedTasks(taskIds) {
  const schedule = loadSchedule();
  schedule.paused = schedule.paused.filter((t) => !taskIds.includes(t.id));
  schedule.scheduled = schedule.scheduled.filter((t) => !taskIds.includes(t.id));
  saveSchedule(schedule);
}

// Get list of paused tasks
export function listPausedTasks() {
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
export function getPausedTaskError(taskId) {
  const schedule = loadSchedule();
  const task = schedule.paused.find((t) => t.id === taskId);
  return task?.errorInfo || null;
}

// Get list of scheduled tasks
export function listScheduledTasks() {
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
export function cancelPausedTask(taskId) {
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
export function cancelScheduledTask(taskId) {
  const schedule = loadSchedule();
  const index = schedule.scheduled.findIndex((t) => t.id === taskId);
  if (index !== -1) {
    const removed = schedule.scheduled.splice(index, 1)[0];
    saveSchedule(schedule);
    return removed;
  }
  return null;
}

// Get a scheduled task by ID without removing it
export function getScheduledTask(taskId) {
  const schedule = loadSchedule();
  return schedule.scheduled.find((t) => t.id === taskId) || null;
}

// Suspend a session for later resumption with feedback
export function suspendSession(sessionId, reason = "awaiting feedback") {
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
export function resumeSuspendedSession(sessionId) {
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
export function getReadySuspendedSessions() {
  const schedule = loadSchedule();
  return schedule.suspendedSessions || [];
}
