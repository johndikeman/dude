/**
 * Worker Agent
 * The implementation agent that executes tasks under manager supervision
 */

import fs from "fs";
import path from "path";
import { SubAgent } from "../session-wrapper.js";
import { createExtensionRuntime, defineTool } from "@mariozechner/pi-coding-agent";

const getPaths = () => {
  const configDir = process.env.DUDE_CONFIG_DIR || process.cwd();
  return {
    configDir,
    logFile: path.join(configDir, "agent.log"),
    sessionsFile: path.join(configDir, "sessions.json"),
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

export class WorkerAgent {
  constructor(options = {}) {
    this.sessionId = options.sessionId;
    this.task = options.task;
    this.acceptanceCriteria = options.acceptanceCriteria;
    this.workDirectories = options.workDirectories || [];
    this.managerSessionId = options.managerSessionId;
    this.workspacePath = options.workspacePath || process.cwd();
    
    this.sessionFile = options.sessionFile;
    this.runtime = null;
    this.isRunning = false;
    this.output = "";
    this.errors = [];
    this.tools = {};
    this.summarySubmitted = false;
  }

  /**
   * Initialize the worker agent with standard developer tools
   */
  async initialize() {
    log(`Initializing worker agent ${this.sessionId}`);
    
    try {
      // Create the session file if it doesn't exist
      if (!fs.existsSync(this.sessionFile)) {
        const sessionDir = path.dirname(this.sessionFile);
        if (!fs.existsSync(sessionDir)) {
          fs.mkdirSync(sessionDir, { recursive: true });
        }
      }

      // Register custom tools for this worker
      this.registerTools();

      this.isRunning = true;
      log(`Worker agent ${this.sessionId} initialized`);
      return true;
    } catch (err) {
      log(`Failed to initialize worker: ${err.message}`);
      this.errors.push(err.message);
      return false;
    }
  }

  /**
   * Register custom tools for the worker agent
   */
  registerTools() {
    // Tool to submit session summary to manager
    this.tools.summarize_and_report = defineTool({
      name: "summarize_and_report",
      description: "Summarize the current session and report to the manager agent",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "Summary of work completed",
          },
          status: {
            type: "string",
            description: "Current status (completed, partial, needs_revision)",
          },
          notes: {
            type: "string",
            description: "Additional notes or issues encountered",
          },
        },
        required: ["summary", "status"],
      },
      execute: async (args) => {
        return this.submitSummary(args);
      },
    });

    // Tool to request more information from manager
    this.tools.request_clarification = defineTool({
      name: "request_clarification",
      description: "Request clarification or more details from the manager agent",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question or clarification needed",
          },
          context: {
            type: "string",
            description: "Current context or what's blocking progress",
          },
        },
        required: ["question"],
      },
      execute: async (args) => {
        return this.requestClarification(args);
      },
    });

    // Tool to update progress
    this.tools.update_progress = defineTool({
      name: "update_progress",
      description: "Update the manager about current progress",
      parameters: {
        type: "object",
        properties: {
          progress: {
            type: "string",
            description: "Description of what was accomplished",
          },
          blockingIssues: {
            type: "array",
            items: { type: "string" },
            description: "Any issues blocking progress",
          },
        },
        required: ["progress"],
      },
      execute: async (args) => {
        return this.updateProgress(args);
      },
    });

    log("Worker tools registered");
  }

  /**
   * Submit a session summary to the manager
   */
  async submitSummary(args) {
    log(`Submitting summary: ${args.summary}`);
    
    const summary = {
      sessionId: this.sessionId,
      managerSessionId: this.managerSessionId,
      task: this.task,
      acceptanceCriteria: this.acceptanceCriteria,
      workDirectories: this.workDirectories,
      ...args,
      output: this.output.substring(0, 5000),
      errors: this.errors,
      timestamp: Date.now(),
    };

    this.summarySubmitted = true;

    // Store summary to session file
    try {
      const summaryLine = JSON.stringify(summary) + "\n";
      fs.appendFileSync(this.sessionFile, summaryLine);
      log(`Summary written to session file`);
    } catch (err) {
      log(`Failed to write summary: ${err.message}`);
    }

    return {
      success: true,
      message: "Summary submitted to manager",
    };
  }

  /**
   * Request clarification from the manager
   */
  async requestClarification(args) {
    log(`Requesting clarification: ${args.question}`);
    
    // In a real implementation, this would communicate with the manager
    // For now, store the request
    const request = {
      type: "clarification_request",
      sessionId: this.sessionId,
      question: args.question,
      context: args.context,
      timestamp: Date.now(),
    };

    try {
      fs.appendFileSync(
        this.sessionFile,
        JSON.stringify({ ...request, requestType: "clarification" }) + "\n",
      );
    } catch (err) {
      log(`Failed to store clarification request: ${err.message}`);
    }

    return {
      acknowledged: true,
      message: "Clarification request logged for manager review",
    };
  }

  /**
   * Update progress with the manager
   */
  async updateProgress(args) {
    log(`Progress update: ${args.progress}`);
    
    const update = {
      type: "progress_update",
      sessionId: this.sessionId,
      progress: args.progress,
      blockingIssues: args.blockingIssues || [],
      timestamp: Date.now(),
    };

    try {
      fs.appendFileSync(
        this.sessionFile,
        JSON.stringify(update) + "\n",
      );
    } catch (err) {
      log(`Failed to store progress update: ${err.message}`);
    }

    return {
      recorded: true,
      message: "Progress update recorded",
    };
  }

  /**
   * Run the worker agent with the given task
   */
  async run() {
    log(`Worker agent running task: ${this.task}`);

    if (!this.isRunning) {
      await this.initialize();
    }

    // Build the worker prompt
    const prompt = this.buildWorkerPrompt();

    // Execute the task
    try {
      const result = await this.executeTask(prompt);
      return result;
    } catch (err) {
      log(`Worker execution error: ${err.message}`);
      this.errors.push(err.message);
      throw err;
    }
  }

  /**
   * Build the worker agent prompt
   */
  buildWorkerPrompt() {
    let prompt = `You are a WORKER agent responsible for implementation tasks.

TASK:
${this.task}

ACCEPTANCE CRITERIA:
${this.acceptanceCriteria || "Complete the task as specified above."}

`;

    if (this.workDirectories.length > 0) {
      prompt += `\nWORKING DIRECTORIES:\n${this.workDirectories.join("\n")}\n`;
    }

    prompt += `
AVAILABLE TOOLS:
- bash: Execute shell commands
- read: Read file contents
- write: Write file contents  
- edit: Make precise edits to files
- summarize_and_report: Submit your session summary when complete
- request_clarification: Ask the manager for clarification if stuck
- update_progress: Report your progress to the manager

GUIDELINES:
1. Focus on the implementation - you don't need to plan extensively
2. Use [STATUS] prefix in your outputs to indicate progress
3. After making significant progress, use update_progress
4. If you complete the task or need to report results, use summarize_and_report
5. If you're blocked or need clarification, use request_clarification
6. Follow coding conventions and best practices
7. Write tests for new functionality
8. Open PRs for code changes

Remember to always check acceptance criteria before claiming completion.
`;

    return prompt;
  }

  /**
   * Execute the task
   */
  async executeTask(prompt) {
    // In a real implementation, this would use pi-coding-agent's AgentSessionRuntime
    // For now, we'll track the execution
    this.output = prompt;
    
    // Simulate task execution tracking
    this.output += `\n[STATUS] starting implementation`;
    
    return {
      sessionId: this.sessionId,
      completed: this.summarySubmitted,
      output: this.output,
      errors: this.errors,
    };
  }

  /**
   * Get the current output
   */
  getOutput() {
    return this.output;
  }

  /**
   * Get errors
   */
  getErrors() {
    return this.errors;
  }

  /**
   * Add to output
   */
  addToOutput(text) {
    this.output += text + "\n";
  }

  /**
   * Check if the agent is running
   */
  running() {
    return this.isRunning;
  }

  /**
   * Get session information
   */
  getSessionInfo() {
    return {
      sessionId: this.sessionId,
      managerSessionId: this.managerSessionId,
      task: this.task,
      acceptanceCriteria: this.acceptanceCriteria,
      workDirectories: this.workDirectories,
      isRunning: this.isRunning,
      summarySubmitted: this.summarySubmitted,
      errors: this.errors,
      outputLength: this.output.length,
    };
  }
}

/**
 * Create a worker agent with the given options
 */
export function createWorkerAgent(options) {
  return new WorkerAgent(options);
}
