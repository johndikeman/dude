/**
 * GitHub Human Interface
 * Handles GitHub interactions via polling PR comments
 */

import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { HumanInterface } from "../base-interface.js";

const getPaths = () => {
  const configDir = process.env.DUDE_CONFIG_DIR || process.cwd();
  return {
    configDir,
    logFile: path.join(configDir, "agent.log"),
  };
};

function log(msg) {
  const { logFile } = getPaths();
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(logFile, line + "\n");
  } catch (e) {}
}

/**
 * Promisify exec
 */
function execAsync(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(
          new Error(`${stderr || error.message}`),
        );
      } else {
        resolve(stdout);
      }
    });
  });
}

export class GitHubInterface extends HumanInterface {
  constructor(config = {}) {
    super({
      ...config,
      name: "github",
      repo: config.repo || process.env.GITHUB_REPO || "",
      checkInterval: config.checkInterval || 5 * 60 * 1000, // 5 minutes default
    });

    this.sessionMapping = new Map(); // Maps session IDs to PR info
    this.lastCheckTime = null;
  }

  /**
   * Initialize the interface
   * @returns {Promise<void>}
   */
  async init() {
    if (!this.config.repo) {
      log("GitHub repo not configured, skipping GitHub interface");
      this.isActive = false;
      return;
    }

    // Test GitHub CLI availability
    try {
      await execAsync("gh --version");
      log("GitHub CLI is available");
    } catch (err) {
      log(`GitHub CLI not available: ${err.message}`);
      this.isActive = false;
      return;
    }

    log(`GitHub interface initialized for repo: ${this.config.repo}`);
  }

  /**
   * Poll for new comments on linked PRs
   * @returns {Promise<void>}
   */
  async poll() {
    if (!this.isActive) return;

    const sessions = this.sessionMapping;
    const now = Date.now();

    for (const [sessionId, prInfo] of sessions) {
      if (!prInfo.prNumber) continue;

      try {
        const comments = await this.fetchPRComments(prInfo.prNumber);
        
        // Find new/resume comments
        const newComment = comments.find((c) => {
          // Check for /resume or "continue" in comment
          const body = c.body || "";
          const isResume = /\/resume|continue this|resum[e]\s+session/i.test(body);
          
          // Only use comments after our last check
          if (this.lastCheckTime && new Date(c.created_at) <= new Date(this.lastCheckTime)) {
            return false;
          }
          
          return isResume;
        });

        if (newComment) {
          log(`Found resumption request on PR #${prInfo.prNumber}: ${newComment.body}`);

          // Emit feedback event
          this.emit("feedback", newComment.body, {
            sessionId,
            prNumber: prInfo.prNumber,
            commentId: newComment.id,
            githubUser: newComment.user?.login,
          });
        }
      } catch (err) {
        log(`Error checking PR #${prInfo.prNumber}: ${err.message}`);
      }
    }

    this.lastCheckTime = now;
  }

  /**
   * Fetch comments from a PR
   * @param {number|string} prNumber - The PR number
   * @returns {Promise<Array<Object>>}
   */
  async fetchPRComments(prNumber) {
    try {
      const output = await execAsync(
        `gh pr view ${prNumber} --repo ${this.config.repo} --json comments`,
      );
      const data = JSON.parse(output);
      return data.comments || [];
    } catch (e) {
      log(`Failed to fetch PR comments: ${e.message}`);
      return [];
    }
  }

  /**
   * Link a PR to a session
   * @param {string} sessionId - The session ID
   * @param {number|string} prNumber - The PR number
   * @param {string} [repo] - GitHub repository
   * @returns {Promise<void>}
   */
  async linkPR(sessionId, prNumber, repo = this.config.repo) {
    this.sessionMapping.set(sessionId, {
      sessionId,
      prNumber,
      repo: repo || this.config.repo,
    });
    log(`Linked PR #${prNumber} to session ${sessionId}`);
  }

  /**
   * Unlink a PR from a session
   * @param {string} sessionId - The session ID
   */
  unlinkPR(sessionId) {
    this.sessionMapping.delete(sessionId);
    log(`Unlinked session ${sessionId}`);
  }

  /**
   * Get session by PR number
   * @param {number|string} prNumber - The PR number
   * @returns {Object|null}
   */
  getSessionByPR(prNumber) {
    for (const [sessionId, info] of this.sessionMapping) {
      if (info.prNumber === prNumber) {
        return info;
      }
    }
    return null;
  }

  /**
   * Get all active sessions with PR info
   * @returns {Array<Object>}
   */
  getActiveSessions() {
    return Array.from(this.sessionMapping.values());
  }

  /**
   * Emit an event to registered handlers
   * @param {string} event - Event name
   * @param {any} data - Event data
   */
  emit(event, data) {
    const handlers = this.callbacks[`on${event.charAt(0).toUpperCase() + event.slice(1)}`];
    if (handlers) {
      handlers.forEach((handler) => handler(data));
    }
  }

  /**
   * Send a message to GitHub (as a PR comment)
   * @param {number|string} prNumber - The PR number
   * @param {string} message - The message content
   * @param {string} [repo] - GitHub repository
   * @returns {Promise<boolean>}
   */
  async sendComment(prNumber, message, repo = this.config.repo) {
    try {
      const fullMessage = `[Agent] ${message}`;
      await execAsync(
        `gh pr comment ${prNumber} --repo ${repo} --body "${fullMessage.replace(/"/g, '\\"')}"`,
      );
      log(`Sent comment to PR #${prNumber}`);
      return true;
    } catch (err) {
      log(`Failed to send comment: ${err.message}`);
      throw err;
    }
  }

  /**
   * Intercept PR creation to associate with session
   * This should be used as a hook/tool wrapper
   * @param {Object} result - Result of pr_create tool
   * @param {string} sessionId - Current session ID
   * @returns {Promise<Object>} The result
   */
  async interceptPRCreate(result, sessionId) {
    if (!result || !result.prNumber) return result;

    // Link the created PR to this session
    await this.linkPR(sessionId, result.prNumber);

    log(`Auto-linked PR #${result.prNumber} to session ${sessionId}`);
    return result;
  }

  /**
   * Fetch open PRs for a session
   * @returns {Promise<Array<Object>>}
   */
  async fetchOpenPRs() {
    try {
      const output = await execAsync(
        `gh pr list --repo ${this.config.repo} --state open --json number,title,author`,
      );
      return JSON.parse(output);
    } catch (err) {
      log(`Failed to fetch open PRs: ${err.message}`);
      return [];
    }
  }

  /**
   * Start polling for interactions
   */
  startPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }
    this.pollingInterval = setInterval(() => this.poll(), this.config.checkInterval);
    log(`GitHub interface polling started (interval: ${this.config.checkInterval}ms)`);
  }

  /**
   * Stop the interface
   * @returns {Promise<void>}
   */
  async stop() {
    this.stopPolling();
    this.isActive = false;
  }
}

/**
 * GitHub Extensions - Pi agent extensions for GitHub-specific functionality
 */
export class GitHubExtensions {
  /**
   * Create a PR link extension
   * This intercepts PR creation and links to session
   */
  static createPRLinkExtension(sessionId, ghInterface) {
    return {
      name: "pr-link",
      description: "Automatically link created PRs to this session",
      hooks: {
        onToolExecute: (tool, args, result) => {
          if (tool.name === "gh_pr_create" && result?.prNumber) {
            ghInterface.interceptPRCreate(result, sessionId);
          }
          return result;
        },
      },
    };
  }

  /**
   * Create a PR comment extension
   * Allows agents to comment on PRs
   */
  static createPRCommentExtension(sessionId, ghInterface) {
    return {
      name: "pr-comment",
      description: "Comment on GitHub PRs",
      tools: [
        {
          name: "comment_on_pr",
          description: "Add a comment to an existing PR",
          parameters: {
            type: "object",
            properties: {
              pr_number: { type: "number", description: "The PR number" },
              message: { type: "string", description: "The message to post" },
            },
            required: ["pr_number", "message"],
          },
          execute: async (args) => {
            const { pr_number, message } = args;
            return await ghInterface.sendComment(pr_number, message);
          },
        },
      ],
    };
  }
}
