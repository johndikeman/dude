#!/usr/bin/env node
/**
 * Dude Message Tool
 * A CLI utility for agents to send messages back to the user via Discord
 */

import fs from "fs";
import path from "path";

const getPaths = () => {
  const configDir = process.env.DUDE_CONFIG_DIR || process.cwd();
  return {
    configDir,
    messageQueueFile: path.join(configDir, "message_queue.jsonl"),
  };
};

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log("Usage: dude-message <message>");
  process.exit(1);
}

const message = args.join(" ");
const { messageQueueFile } = getPaths();

const entry = {
  timestamp: Date.now(),
  message: message,
  sessionId: process.env.DUDE_SESSION_ID,
};

try {
  fs.appendFileSync(messageQueueFile, JSON.stringify(entry) + "\n");
  console.log("Message queued for delivery.");
} catch (err) {
  console.error("Failed to queue message:", err.message);
  process.exit(1);
}
