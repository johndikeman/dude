/**
 * Manager Agent
 * The top-level agent that plans, coordinates, and evaluates worker agents
 */

import fs from "fs";
import path from "path";
import { AgentSessionWrapper, SubAgent } from "../session-wrapper.js";
import { WorkerAgent } from "../worker/worker-agent.js";
import { GitHubExtensions } from "../../hi/github/github-interface.js";
import { defineTool, createCodingTools } from "@mariozechner/pi-coding-agent";
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
    this.githubInterface = options.githubInterface;
    this.sourceInterface = options.sourceInterface;
  }

  /**
   * Run the manager agent workflow
   */
  async run() {
    log(`Manager agent starting for task: ${this.task}`);

    // Register manager-specific tools
    const planReadyTool = defineTool({
      name: "plan_ready",
      description:
        "Submit the developed plan and acceptance criteria for approval",
      parameters: Type.Object({
        plan: Type.String({ description: "Detailed implementation plan" }),
        acceptanceCriteria: Type.String({
          description: "Clear, measurable criteria for task completion",
        }),
        workDirectories: Type.Array(Type.String(), {
          description: "Directories the worker agent should have access to",
        }),
      }),
      execute: async (args) => {
        this.plan = { summary: args.plan };
        this.acceptanceCriteria = args.acceptanceCriteria;
        this.workDirectories = args.workDirectories;
        await this.notifyPlanReady();
        return {
          content: [{ type: "text", text: "Plan submitted for approval." }],
        };
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
          return {
            content: [
              { type: "text", text: "Worker agent resumed with feedback." },
            ],
          };
        } else {
          return {
            content: [{ type: "text", text: "No active worker to resume." }],
            isError: true,
          };
        }
      },
    });

    const messageUserTool = defineTool({
      name: "message_user",
      description:
        "Send a message to the user for feedback, clarification, or updates",
      parameters: Type.Object({
        message: Type.String({
          description: "The message to send to the user",
        }),
      }),
      execute: async (args) => {
        await this.notifyUser(args.message);
        return { content: [{ type: "text", text: "Message sent to user." }] };
      },
    });

    const customTools = [
      planReadyTool,
      startWorkerTool,
      resumeWorkerTool,
      messageUserTool,
    ];

    // Add GitHub tools if interface is available
    if (this.githubInterface) {
      customTools.push(
        defineTool({
          name: "gh_fetch_open_prs",
          description: "Fetch open pull requests from the repository",
          parameters: Type.Object({}),
          execute: async () => {
            const prs = await this.githubInterface.fetchOpenPRs();
            return { content: [{ type: "text", text: JSON.stringify(prs, null, 2) }] };
          },
        }),
        defineTool({
          name: "gh_fetch_pr_comments",
          description: "Fetch comments from a specific pull request",
          parameters: Type.Object({
            pr_number: Type.Number({ description: "The PR number" }),
          }),
          execute: async ({ pr_number }) => {
            const comments = await this.githubInterface.fetchPRComments(pr_number);
            return { content: [{ type: "text", text: JSON.stringify(comments, null, 2) }] };
          },
        }),
        defineTool({
          name: "gh_clone_repo",
          description: "Clone a GitHub repository to a specific directory",
          parameters: Type.Object({
            repo: Type.String({ description: "The repository to clone (e.g. 'owner/repo')" }),
            directory: Type.Optional(Type.String({ description: "Optional destination directory name" })),
          }),
          execute: async ({ repo, directory }) => {
            const result = await this.githubInterface.cloneRepo(repo, directory);
            return { content: [{ type: "text", text: result || `Successfully cloned ${repo}` }] };
          },
        })
      );
    }

    const prompt = `You are a manager agent responsible for planning and coordinating the following task:

${this.task}

Your job is to:
1. Research the codebase to understand requirements.
2. If the task requires a repository that is not currently present, use gh_clone_repo to clone it.
3. Develop a detailed implementation plan.
4. Define clear acceptance criteria.
5. Once ready, call plan_ready to submit your plan for approval.
6. Once approved (you will receive a message), call start_worker to begin implementation.
7. After the worker completes, evaluate their results.

You can use message_user at any time to ask for clarification or provide updates.
${this.githubInterface ? "You can use gh_* tools to interact with GitHub (fetching PRs, cloning repos) if relevant to the task." : ""}

You have READ-ONLY access to the codebase for research.
Use [STATUS] prefix to indicate your progress.
`;

    const readOnlyTools = createCodingTools(this.workspacePath).filter((tool) =>
      ["read", "bash", "ls", "grep", "find"].includes(tool.name),
    );

    return await super.start(prompt, {
      tools: readOnlyTools,
      customTools,
    });
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

  async runWorkerPhase() {
    if (!this.plan || !this.acceptanceCriteria) {
      throw new Error(
        "Plan and acceptance criteria must be set before starting worker",
      );
    }

    // Create a worker agent
    const workerSessionId = `worker-${this.sessionId}-${Date.now()}`;
    const workerSessionFile = path.join(
      getPaths().configDir,
      "sessions",
      `${workerSessionId}.jsonl`,
    );

    this.setStatus("spawning worker agent for implementation");

    const worker = new WorkerAgent({
      sessionId: workerSessionId,
      managerAgent: this,
      task: this.task,
      acceptanceCriteria: this.acceptanceCriteria,
      workDirectories: this.workDirectories,
      workspacePath: this.workspacePath,
      onStatusUpdate: (status) => {
        this.setStatus(`Worker: ${status}`);
      },
    });

    this.workerAgents.set(workerSessionId, worker);
    this.activeWorker = worker;
    this.sessionHistory.push(workerSessionId);

    // Setup extensions
    const extensions = [];
    if (this.githubInterface) {
      extensions.push(
        GitHubExtensions.createPRLinkExtension(
          workerSessionId,
          this.githubInterface,
        ),
      );
      extensions.push(
        GitHubExtensions.createPRCommentExtension(
          workerSessionId,
          this.githubInterface,
        ),
      );
    }

    // Start the worker
    try {
      await worker.run({ extensions });
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
    const hasCompletion = /task complete|finished|done|implemente[d]?/i.test(
      workerOutput,
    );
    const hasPrCreated = /pull request|pr created|opened pr/i.test(
      workerOutput,
    );
    const hasNoErrors =
      !/error|failed|exception/i.test(workerOutput) ||
      /error handling/i.test(workerOutput);

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
      await this.messageCallback(
        "worker_completed",
        "Worker completed: " +
          (result.status || result.output?.substring(0, 200)),
      );
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
      sourceInterface: this.sourceInterface,
      discordChannelId: this.discordChannelId,
      discordMessageId: this.discordMessageId,
    };
  }
}

/**
 * Create a manager agent with the given options
 */
export function createManagerAgent(options) {
  return new ManagerAgent(options);
}
