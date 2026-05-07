/**
 * Worker Agent
 * The implementation agent that executes tasks under manager supervision
 */

import fs from "fs";
import path from "path";
import { SubAgent } from "../session-wrapper.js";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

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

export class WorkerAgent extends SubAgent {
  constructor(options = {}) {
    const sessionFile = path.join(
      getPaths().configDir,
      "sessions",
      `${options.sessionId}.jsonl`,
    );
    super(options.sessionId, sessionFile, options.managerAgent, {
      ...options,
      role: "worker",
    });
    
    this.task = options.task;
    this.acceptanceCriteria = options.acceptanceCriteria;
    this.workDirectories = options.workDirectories || [];
    this.workspacePath = options.workspacePath || process.cwd();
  }

  /**
   * Run the worker agent
   */
  async run(options = {}) {
    log(`Worker agent ${this.sessionId} starting for task: ${this.task}`);

    const extensions = options.extensions || [];
    const requestClarificationTool = defineTool({
      name: "request_clarification",
      description: "Request clarification or more details from the manager agent",
      parameters: Type.Object({
        question: Type.String({ description: "The question or clarification needed" }),
        context: Type.String({ description: "Current context or what's blocking progress" }),
      }),
      execute: async (args) => {
        log(`Worker requested clarification: ${args.question}`);
        if (this.parentAgent && this.parentAgent.notifyUser) {
          await this.parentAgent.notifyUser(`Worker Agent Request: ${args.question}\nContext: ${args.context}`);
        }
        return { content: [{ type: "text", text: "Clarification request sent to manager and user." }] };
      },
    });

    const updateProgressTool = defineTool({
      name: "update_progress",
      description: "Update the manager about current progress",
      parameters: Type.Object({
        progress: Type.String({ description: "Description of what was accomplished" }),
      }),
      execute: async (args) => {
        log(`Worker progress update: ${args.progress}`);
        return { content: [{ type: "text", text: "Progress update recorded." }] };
      },
    });

    const prompt = `You are a WORKER agent responsible for implementation tasks.

TASK:
${this.task}

ACCEPTANCE CRITERIA:
${this.acceptanceCriteria || "Complete the task as specified above."}

WORKING DIRECTORIES:
${this.workDirectories.join("\n") || this.workspacePath}

GUIDELINES:
1. Focus on the implementation - you don't need to plan extensively.
2. Use [STATUS] prefix in your outputs to indicate progress.
3. After making significant progress, use update_progress.
4. If you complete the task or need to report results, use summarize_and_report.
5. If you're blocked or need clarification, use request_clarification.
6. Follow coding conventions and best practices.
7. Write tests for new functionality.
8. Open PRs for code changes.

Remember to always check acceptance criteria before claiming completion.
`;

    return await super.start(this.task, {
      cwd: this.workspacePath,
      customTools: [requestClarificationTool, updateProgressTool],
      extensions: extensions,
    });
  }
}

/**
 * Create a worker agent with the given options
 */
export function createWorkerAgent(options) {
  return new WorkerAgent(options);
}
