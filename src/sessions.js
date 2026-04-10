import fs from "fs";
import path from "path";

const CONFIG_DIR = process.env.DUDE_CONFIG_DIR || process.cwd();
const SESSIONS_FILE = path.join(CONFIG_DIR, "sessions.json");
const LOG_FILE = path.join(CONFIG_DIR, "agent.log");

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (e) {}
}

// Load sessions from file
export function loadSessions() {
  if (!fs.existsSync(SESSIONS_FILE)) {
    return { active: [], completed: [] };
  }
  try {
    const content = fs.readFileSync(SESSIONS_FILE, "utf8");
    return JSON.parse(content);
  } catch (e) {
    log(`Error loading sessions: ${e.message}`);
    return { active: [], completed: [] };
  }
}

// Save sessions to file
export function saveSessions(sessions) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

// Create a new session entry
export function createSession(task, options = {}) {
  const sessions = loadSessions();
  const now = Date.now();

  const session = {
    id: Date.now().toString(),
    task,
    createdAt: now,
    status: "active",
    discordMessageId: options.discordMessageId || null,
    discordChannelId: options.discordChannelId || null,
    prNumber: options.prNumber || null,
    prRepo: options.prRepo || null,
    workspacePath: options.workspacePath || process.cwd(),
    prompt: options.prompt || null,
  };

  sessions.active.push(session);
  saveSessions(sessions);
  return session;
}

// Get a session by ID
export function getSession(sessionId) {
  const sessions = loadSessions();
  return (
    sessions.active.find((s) => s.id === sessionId) ||
    sessions.completed.find((s) => s.id === sessionId) ||
    null
  );
}

// Get session by Discord message ID
export function getSessionByDiscordMessage(messageId) {
  const sessions = loadSessions();
  return (
    sessions.active.find((s) => s.discordMessageId === messageId) ||
    sessions.completed.find((s) => s.discordMessageId === messageId) ||
    null
  );
}

// Get session by PR number and repo
export function getSessionByPR(prNumber, prRepo) {
  const sessions = loadSessions();
  return (
    sessions.active.find((s) => s.prNumber === prNumber && s.prRepo === prRepo) ||
    sessions.completed.find((s) => s.prNumber === prNumber && s.prRepo === prRepo) ||
    null
  );
}

// Update a session
export function updateSession(sessionId, updates) {
  const sessions = loadSessions();
  const index = sessions.active.findIndex((s) => s.id === sessionId);
  if (index === -1) return null;

  sessions.active[index] = { ...sessions.active[index], ...updates };
  saveSessions(sessions);
  return sessions.active[index];
}

// Link a Discord message to a session
export function linkDiscordMessage(sessionId, messageId, channelId) {
  return updateSession(sessionId, { discordMessageId: messageId, discordChannelId: channelId });
}

// Link a PR to a session
export function linkPR(sessionId, prNumber, prRepo) {
  return updateSession(sessionId, { prNumber, prRepo });
}

// Finish a session with a specific status
export function finishSession(sessionId, status = "completed") {
  const sessions = loadSessions();
  const index = sessions.active.findIndex((s) => s.id === sessionId);
  if (index === -1) return null;

  const session = sessions.active.splice(index, 1)[0];
  session.status = status;
  session.completedAt = Date.now();
  sessions.completed.push(session);

  // Keep only last 50 completed sessions
  if (sessions.completed.length > 50) {
    sessions.completed = sessions.completed.slice(-50);
  }

  saveSessions(sessions);
  return session;
}

// Complete a session
export function completeSession(sessionId) {
  return finishSession(sessionId, "completed");
}

// Archive old completed sessions
export function archiveCompletedSessions() {
  const sessions = loadSessions();
  const now = Date.now();
  const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1000;
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  // Remove sessions that are either audited AND older than 24h,
  // OR they are older than 3 days regardless of audit status.
  sessions.completed = sessions.completed.filter((s) => {
    if (s.audited && s.completedAt < oneDayAgo) return false;
    if (s.completedAt < threeDaysAgo) return false;
    return true;
  });
  saveSessions(sessions);
}

// Get active sessions
export function getActiveSessions() {
  const sessions = loadSessions();
  return sessions.active.map((s) => ({
    id: s.id,
    task: s.task,
    createdAt: new Date(s.createdAt).toLocaleString(),
    discordMessageId: s.discordMessageId,
    prNumber: s.prNumber,
    status: s.status,
  }));
}

// Find sessions ready to resume (have user feedback via reply/comment)
export function getSuspendingSessions() {
  const sessions = loadSessions();
  // This would be populated by external checks (GitHub webhook, Discord events)
  // For now, return empty - checking is done via external mechanisms
  return [];
}
