/**
 * AgentSessionWrapper - A wrapper around the pi-coding-agent AgentSession API
 * This provides a simpler interface for dude's needs while maintaining compatibility
 * with the underlying pi-coding-agent session management.
 */

import {
  AuthStorage,
  createAgentSession,
  createCodingTools,
  DefaultResourceLoader,
  defineTool,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import fs from "fs";
import path from "path";
import { Type } from "@sinclair/typebox";

const getPaths = () => {
  const configDir = process.env.DUDE_CONFIG_DIR || process.cwd();
  return {
    configDir,
    logFile: path.join(configDir, "agent.log"),
    agentDir: path.join(configDir, ".pi"),
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

export class AgentSessionWrapper {
  constructor(sessionId, sessionFile, config = {}) {
    this.sessionId = sessionId;
    this.sessionFile = sessionFile;
    this.config = config;
    this.session = null;
    this.isRunning = false;
    this.output = "";
    this.error = "";
    this.events = [];
    this.statusLines = [];
  }

  /**
   * Initialize and start the agent session
   * @param {string} prompt - The initial prompt/task
   * @param {Object} options - Session options
   */
  async start(prompt, options = {}) {
    const {
      provider = process.env.PI_MODEL_PROVIDER || "google-gemini-cli",
      modelCode = process.env.PI_MODEL || "gemini-3-flash-preview",
      skills = [],
      extensions = [],
      customTools = [],
      cwd = process.cwd(),
    } = options;

    const { agentDir } = getPaths();
    log(`Starting agent session ${this.sessionId} with model ${modelCode}`);
    
    try {
      const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
      const modelRegistry = ModelRegistry.create(authStorage, path.join(agentDir, "models.json"));
      
      const model = modelRegistry.find(provider, modelCode) || getModel(provider, modelCode);
      if (!model) {
        throw new Error(`Model not found: ${provider}/${modelCode}`);
      }

      const settingsManager = SettingsManager.create(cwd, agentDir);
      const sessionManager = this.sessionFile 
        ? SessionManager.open(this.sessionFile)
        : SessionManager.inMemory();

      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
      });
      
      // Add inline extensions if any
      if (options.extensionFactories) {
        loader.options.extensionFactories = [
          ...(loader.options.extensionFactories || []),
          ...options.extensionFactories
        ];
      }
      
      await loader.reload();

      const { session } = await createAgentSession({
        cwd,
        agentDir,
        model,
        authStorage,
        modelRegistry,
        settingsManager,
        sessionManager,
        resourceLoader: loader,
        tools: createCodingTools(cwd),
        customTools: customTools,
      });

      this.session = session;
      this.isRunning = true;

      // Register event handlers
      session.subscribe((event) => {
        this.events.push(event);
        
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          this.output += event.assistantMessageEvent.delta;
          
          // Check for status lines in the accumulated output or just in the delta
          // This is a bit simplified, ideally we'd look at the full message
        }

        if (event.type === "message_end" && event.message.role === "assistant") {
          // Extract status lines from complete message
          for (const content of event.message.content) {
            if (content.type === "text" && content.text) {
              const lines = content.text.split("\n");
              for (const line of lines) {
                const statusMatch = line.match(/\[STATUS\]\s*(.+)/i);
                if (statusMatch) {
                  this.statusLines.push(statusMatch[1].trim());
                }
              }
            }
          }
        }

        if (event.type === "agent_end") {
          this.isRunning = false;
          log(`Session ended`);
        }

        if (event.type === "error") {
          this.error = event.error || "Unknown error";
          this.isRunning = false;
          log(`Session error: ${this.error}`);
        }
      });

      // Start the session with the prompt
      await session.prompt(prompt);

      return { success: true, sessionId: this.sessionId };
    } catch (err) {
      this.error = err.message;
      this.isRunning = false;
      log(`Failed to start agent session: ${err.message}`);
      throw err;
    }
  }

  /**
   * Resume the session with new context/feedback
   * @param {string} feedback - Feedback or continuation text
   */
  async resume(feedback) {
    if (!this.session) {
      throw new Error("Session not initialized");
    }

    log(`Resuming session ${this.sessionId} with feedback`);
    this.isRunning = true;

    try {
      await this.session.prompt(feedback);
      return { success: true };
    } catch (err) {
      this.error = err.message;
      this.isRunning = false;
      throw err;
    }
  }

  /**
   * Send a steering message during execution
   */
  async steer(text) {
    if (!this.session) throw new Error("Session not initialized");
    return await this.session.steer(text);
  }

  /**
   * Send a follow-up message
   */
  async followUp(text) {
    if (!this.session) throw new Error("Session not initialized");
    return await this.session.followUp(text);
  }

  /**
   * Send a tool call or message to the agent
   * @param {string} message - The message or tool result
   */
  async sendMessage(message) {
    if (!this.session) {
      throw new Error("Session not initialized");
    }

    log(`Sending message to session ${this.sessionId}`);
    return await this.session.prompt(message);
  }

  /**
   * Get the current session output
   */
  getOutput() {
    return this.output;
  }

  /**
   * Get the latest status line
   */
  getStatus() {
    return this.statusLines.length > 0 
      ? this.statusLines[this.statusLines.length - 1] 
      : null;
  }

  /**
   * Get all status lines
   */
  getStatusLines() {
    return this.statusLines;
  }

  /**
   * Get all events
   */
  getEvents() {
    return this.events;
  }

  /**
   * Check if session has errors
   */
  hasError() {
    return this.error.length > 0;
  }

  /**
   * Get the error message
   */
  getError() {
    return this.error;
  }

  /**
   * Stop the session gracefully
   */
  async stop() {
    if (this.session && this.isRunning) {
      log(`Stopping session ${this.sessionId}`);
      try {
        await this.session.abort();
      } catch (e) {
        log(`Error stopping session: ${e.message}`);
      }
      this.isRunning = false;
    }
  }

  /**
   * Kill the session forcefully
   */
  kill() {
    if (this.session && this.isRunning) {
      log(`Killing session ${this.sessionId}`);
      this.session.dispose?.();
      this.isRunning = false;
    }
  }

  /**
   * Check if session is quota exhausted
   * @returns {Object|null} - Quota error info or null
   */
  isQuotaExhausted() {
    const error = this.error || this.getOutput();
    if (!error) return null;

    // Check for quota error patterns
    const has429 = error.includes("429");
    const hasCapacityError = error.includes("exhausted your capacity") || error.includes("No capacity available");
    const hasQuotaReset = error.includes("quota will reset") || error.includes("Quota exhausted");

    if (has429 && (hasCapacityError || hasQuotaReset)) {
      // Try to extract reset time
      const timeMatch = error.match(/quota will reset after ([0-9]+h)?([0-9]+m)?([0-9]+s)?/i);
      if (timeMatch) {
        const timeStr = timeMatch[0].replace(/quota will reset after /i, "");
        const ms = this.parseTimeToMs(timeStr);
        return {
          type: "quota_exhausted",
          resetAfterMs: ms,
          errorMessage: error,
        };
      }
      return {
        type: "quota_exhausted",
        resetAfterMs: 3600000, // default 1 hour
        errorMessage: error,
      };
    }

    return null;
  }

  /**
   * Parse time string like "3h50m3s" to milliseconds
   */
  parseTimeToMs(timeStr) {
    if (!timeStr) return 3600000;

    const hoursMatch = timeStr.match(/(\d+)h/);
    const minutesMatch = timeStr.match(/(\d+)m/);
    const secondsMatch = timeStr.match(/(\d+)s/);

    const hours = hoursMatch ? parseInt(hoursMatch[1], 10) : 0;
    const minutes = minutesMatch ? parseInt(minutesMatch[1], 10) : 0;
    const seconds = secondsMatch ? parseInt(secondsMatch[1], 10) : 0;

    return (hours * 3600 + minutes * 60 + seconds) * 1000;
  }

  /**
   * Get session info for serialization
   */
  getSessionInfo() {
    return {
      sessionId: this.sessionId,
      sessionFile: this.sessionFile,
      isRunning: this.isRunning,
      hasError: this.hasError(),
      output: this.getOutput().substring(0, 1000), // Truncate for storage
      status: this.getStatus(),
      lastUpdated: Date.now(),
    };
  }
}

/**
 * SubAgent - A subclass for hierarchical agent composition
 * SubAgents can report their session summary to parent agents
 */
export class SubAgent extends AgentSessionWrapper {
  constructor(sessionId, sessionFile, parentAgent = null, config = {}) {
    super(sessionId, sessionFile, config);
    this.parentAgent = parentAgent;
    this.role = config.role || "worker";
    this.acceptanceCriteria = config.acceptanceCriteria || null;
    this.workDirectories = config.workDirectories || [];
  }

  /**
   * Start the sub-agent with specific task and acceptance criteria
   */
  async start(task, options = {}) {
    const prompt = `You are a ${this.role} agent with the following task:

${task}

${this.acceptanceCriteria ? `Acceptance Criteria:\n${this.acceptanceCriteria}\n` : ""}
${this.workDirectories.length > 0 ? `Working directories:\n${this.workDirectories.join("\n")}\n` : ""}

Use the [STATUS] prefix in your messages to indicate progress.
When complete, use the summarize_and_report tool to submit your results.
`;

    // Define the summarize_and_report tool
    const summarizeTool = defineTool({
      name: "summarize_and_report",
      label: "Summarize and Report",
      description: "Summarize the current session and report to the manager agent",
      parameters: Type.Object({
        summary: Type.String({ description: "Summary of work completed" }),
        status: Type.String({ description: "Current status (completed, partial, needs_revision)" }),
        notes: Type.Optional(Type.String({ description: "Additional notes or issues encountered" })),
      }),
      execute: async (params) => {
        return await this.summarize_and_report(params);
      },
    });

    options.customTools = [...(options.customTools || []), summarizeTool];

    return super.start(prompt, options);
  }

  /**
   * Add a custom tool for summarizing and reporting to parent
   * This should be called by the agent during its execution
   */
  async summarize_and_report(params) {
    if (!this.parentAgent) {
      throw new Error("No parent agent configured");
    }

    const summary = {
      sessionId: this.sessionId,
      task: this.config.task,
      acceptanceCriteria: this.acceptanceCriteria,
      output: this.getOutput(),
      status: this.getStatus(),
      completed: params.status === "completed",
      workDirectories: this.workDirectories,
      ...params,
    };

    // Send summary to parent agent
    await this.parentAgent.receiveSubAgentResult(summary);
    return { content: [{ type: "text", text: "Summary reported to manager." }] };
  }

  /**
   * Report a result directly to parent
   */
  async reportToParent(result) {
    if (!this.parentAgent) {
      throw new Error("No parent agent configured");
    }
    await this.parentAgent.receiveSubAgentResult(result);
  }

  /**
   * Get session info including parent relationship
   */
  getSessionInfo() {
    const info = super.getSessionInfo();
    info.parentAgentId = this.parentAgent?.sessionId || null;
    info.role = this.role;
    info.acceptanceCriteria = this.acceptanceCriteria;
    return info;
  }
}
