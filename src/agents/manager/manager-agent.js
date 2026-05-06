/**
 * Manager Agent
 * The top-level agent that plans, coordinates, and evaluates worker agents
 */

import fs from "fs";
import path from "path";
import { AgentSessionWrapper, SubAgent } from "../session-wrapper.js";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

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

export class ManagerAgent extends AgentSessionWrapper {
  constructor(options = {}) {
    const sessionFile = path.join(
      getPaths().configDir,
      "sessions",
      `${options.sessionId}.jsonl`,
    );
    super(options.sessionId, sessionFile, options);
    
    this.task = options.task;
    this.discordMessageId = options.discordMessageId;
    this.discordChannelId = options.discordChannelId;
    this.workspacePath = options.workspacePath || process.cwd();
    this.statusCallback = options.statusCallback || (() => {});
    this.messageCallback = options.messageCallback || (() => {});
    
    this.workerAgents = new Map(); // sessionId -> SubAgent
    this.activeWorker = null;
    this.plan = null;
    this.acceptanceCriteria = null;
    this.workDirectories = [];
    this.phase = "planning"; // planning, waiting_for_approval, executing, evaluating, complete
    this.lastStatus = "Starting...";
    this.sessionHistory = []; // Track subagent sessions
  }

  /**
   * Run the manager agent workflow
   */
  async run() {
    log(`Manager agent starting for task: ${this.task}`);
    
    // Register manager-specific tools
    const planReadyTool = defineTool({
      name: "plan_ready",
      description: "Submit the developed plan and acceptance criteria for approval",
      parameters: Type.Object({
        plan: Type.String({ description: "Detailed implementation plan" }),
        acceptanceCriteria: Type.String({ description: "Clear, measurable criteria for task completion" }),
        workDirectories: Type.Array(Type.String(), { description: "Directories the worker agent should have access to" }),
      }),
      execute: async (args) => {
        this.plan = { summary: args.plan };
        this.acceptanceCriteria = args.acceptanceCriteria;
        this.workDirectories = args.workDirectories;
        await this.notifyPlanReady();
        return { content: [{ type: "text", text: "Plan submitted for approval." }] };
      },
    });

    const startWorkerTool = defineTool({
      name: "start_worker",
      description: "Start the worker agent with the approved plan",
      parameters: Type.Object({}),
      execute: async () => {
        await this.runWorkerPhase();
        return { content: [{ type: "text", text: "Worker agent started." }] };
      },
    });

    const resumeWorkerTool = defineTool({
      name: "resume_worker",
      description: "Resume the worker agent with feedback for revisions",
      parameters: Type.Object({
        feedback: Type.String({ description: "Feedback for the worker agent" }),
      }),
      execute: async (args) => {
        if (this.activeWorker) {
          await this.activeWorker.resume(args.feedback);
          return { content: [{ type: "text", text: "Worker agent resumed with feedback." }] };
        } else {
          return { content: [{ type: "text", text: "No active worker to resume." }], isError: true };
        }
      },
    });

    const prompt = `You are a manager agent responsible for planning and coordinating the following task:

${this.task}

Your job is to:
1. Research the codebase to understand requirements.
2. Develop a detailed implementation plan.
3. Define clear acceptance criteria.
4. Once ready, call plan_ready to submit your plan for approval.
5. Once approved (you will receive a message), call start_worker to begin implementation.
6. After the worker completes, evaluate their results.

You have READ-ONLY access to the codebase for research.
Use [STATUS] prefix to indicate your progress.
`;

    return await super.start(prompt, {
      customTools: [planReadyTool, startWorkerTool, resumeWorkerTool],
      // Manager should be read-only - we can enforce this by only giving it read tools
      // but pi-coding-agent default tools include write/edit/bash.
      // We'll override them to be read-only where possible.
    });
  }

  /**
   * Phase 1: Create a plan for the task
   */
  async runPlanPhase() {
    const planPrompt = `You are a manager agent responsible for planning how to implement the following task:

${this.task}

Your job is to:
1. Analyze the task requirements
2. Research the codebase if needed
3. Develop a detailed implementation plan
4. Define clear acceptance criteria

Output your plan in this format:
--- PLAN ---
[Your detailed plan here]
--- ACCEPTANCE CRITERIA ---
[Clear, measurable criteria for task completion]
--- WORKING DIRECTORIES ---
[Directories the worker agent should have access to]
--- END ---

Use bash tools to explore the codebase as needed.
Remember to use [STATUS] prefix to indicate your progress.
When ready, call the plan_ready tool to submit your plan.
`;

    // For now, we'd use pi AgentSession API here
    // This is a simplified version using bash exploration
    log("Creating plan for task");
    
    try {
      // Explore the codebase
      const repoStructure = await this.exploreCodebase();
      
      this.plan = {
        summary: `Implement: ${this.task.substring(0, 50)}...`,
        steps: ["Initial plan created"],
        requiresResearch: true,
        estimatedTime: "unknown",
        codebaseSnapshot: repoStructure.substring(0, 2000),
      };
      
      this.acceptanceCriteria = `Task "${this.task}" should be completed according to the plan.
- All requirements from the task description must be addressed
- Code should follow existing patterns
- Tests should be added for new functionality
- Documentation should be updated`;

      this.workDirectories = [this.workspacePath];
      
      log("Plan phase complete");
      return { plan: this.plan, acceptanceCriteria: this.acceptanceCriteria };
    } catch (err) {
      log(`Error in plan phase: ${err.message}`);
      throw err;
    }
  }

  /**
   * Phase 2: Notify that plan is ready
   */
  async notifyPlanReady() {
    const message = `📋 **Plan Ready for Approval**

**Task:** ${this.task}

**Plan Summary:**
${this.plan?.summary || "See full plan"}

**Acceptance Criteria:**
${this.acceptanceCriteria || "See acceptance criteria"}

Reply to this message to approve the plan and start implementation.`;

    if (this.messageCallback) {
      await this.messageCallback("plan_ready", message, {
        plan: this.plan,
        acceptanceCriteria: this.acceptanceCriteria,
      });
    }

    log("Plan ready notification sent");
  }

  /**
   * Phase 3: Run worker agent with our plan
   */
  async runWorkerPhase() {
    if (!this.plan || !this.acceptanceCriteria) {
      throw new Error("Plan and acceptance criteria must be set before starting worker");
    }

    // Create a worker agent
    const workerSessionId = `worker-${this.sessionId}-${Date.now()}`;
    const workerSessionFile = path.join(
      getPaths().configDir,
      "sessions",
      `${workerSessionId}.jsonl`,
    );

    this.setStatus("spawning worker agent for implementation");

    const worker = new SubAgent(
      workerSessionId,
      workerSessionFile,
      this,
      {
        role: "worker",
        task: this.task,
        acceptanceCriteria: this.acceptanceCriteria,
        workDirectories: this.workDirectories,
      },
    );

    this.workerAgents.set(workerSessionId, worker);
    this.activeWorker = worker;
    this.sessionHistory.push(workerSessionId);

    // Start the worker
    try {
      await worker.start(this.task, {
        cwd: this.workspacePath,
      });
      log(`Worker agent ${workerSessionId} started`);
      return { workerId: workerSessionId };
    } catch (err) {
      log(`Failed to start worker: ${err.message}`);
      throw err;
    }
  }

  /**
   * Phase 4: Evaluate worker results
   */
  async runEvaluationPhase() {
    if (!this.activeWorker) {
      log("No worker to evaluate");
      return { evaluated: false };
    }

    // Wait for worker to complete
    while (this.activeWorker.isRunning) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    // Get worker output
    const workerOutput = this.activeWorker.getOutput();
    
    log("Evaluating worker results...");

    // Simple evaluation logic
    const success = this.evaluateResults(workerOutput);
    
    if (success) {
      this.phase = "complete";
      this.setStatus("worker completed successfully");
      return { evaluated: true, success: true };
    } else {
      this.phase = "revise";
      this.setStatus("worker output needs revision");
      
      // Resume worker with feedback
      const feedback = `The previous implementation did not fully meet the acceptance criteria. Please review and improve:

${this.acceptanceCriteria}

Previous output:
${workerOutput.substring(0, 3000)}`;

      return {
        evaluated: true,
        success: false,
        feedback,
      };
    }
  }

  /**
   * Evaluate if worker results meet acceptance criteria
   */
  evaluateResults(workerOutput) {
    // Check for key indicators of completion
    const hasCompletion = /task complete|finished|done|implemente[d]?/i.test(workerOutput);
    const hasPrCreated = /pull request|pr created|opened pr/i.test(workerOutput);
    const hasNoErrors = !/error|failed|exception/i.test(workerOutput) || /error handling/i.test(workerOutput);

    // Simple heuristic - in production, use AI for better evaluation
    return hasCompletion && (hasPrCreated || hasNoErrors);
  }

  /**
   * Receive results from a worker agent
   */
  async receiveSubAgentResult(result) {
    log(`Received result from worker ${result.sessionId}`);
    
    // Resume manager session with worker results for evaluation
    const evaluationPrompt = `WORKER COMPLETED.
Summary of work: ${result.summary}
Status: ${result.status}
Notes: ${result.notes || "None"}

Please evaluate if the work meets the acceptance criteria:
${this.acceptanceCriteria}

If it's good, send a final message to the user.
If it needs revisions, call resume_worker with your feedback.
`;
    
    await this.resume(evaluationPrompt);

    // Notify through callback
    if (this.messageCallback) {
      await this.messageCallback("worker_completed", "Worker completed: " + (result.status || result.output?.substring(0, 200)));
    }

    return true;
  }

  /**
   * Notify user via Discord
   */
  async notifyUser(message) {
    if (this.messageCallback) {
      await this.messageCallback("user_message", message);
    }
  }

  /**
   * Explore the codebase
   */
  async exploreCodebase() {
    try {
      const { exec: execCmd } = await import("child_process");
      return new Promise((resolve, reject) => {
        execCmd("ls -la && find . -maxdepth 2 -type f -name '*.js' | head -20", {
          cwd: this.workspacePath,
          timeout: 10000,
        }, (error, stdout, stderr) => {
          if (error) {
            reject(error);
          } else {
            resolve(stdout || stderr);
          }
        });
      });
    } catch (err) {
      log(`Error exploring codebase: ${err.message}`);
      return "Unable to explore codebase";
    }
  }

  /**
   * Set the current status
   */
  setStatus(status) {
    this.lastStatus = status;
    this.statusCallback(status);
  }

  /**
   * Get the current status
   */
  getStatus() {
    return this.lastStatus;
  }

  /**
   * Get the session info
   */
  getSessionInfo() {
    return {
      sessionId: this.sessionId,
      task: this.task,
      phase: this.phase,
      plan: this.plan,
      workerAgents: Array.from(this.workerAgents.keys()),
      sessionHistory: this.sessionHistory,
      lastStatus: this.lastStatus,
    };
  }
}

/**
 * Create a manager agent with the given options
 */
export function createManagerAgent(options) {
  return new ManagerAgent(options);
}
