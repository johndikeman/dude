# Manager-Worker Communication Skill

This skill provides patterns for communication between manager and worker agents in the subagent architecture.

## Message Formats

### Manager to Worker

```json
{
  "type": "task_assignment",
  "sessionId": "manager-123",
  "workerSessionId": "worker-456",
  "task": "Implement feature X",
  "acceptanceCriteria": [
    "Feature works as described",
    "Tests pass",
    "PR created"
  ],
  "workDirectories": ["/path/to/repo"],
  "timestamp": 1234567890
}
```

### Worker to Manager (Summary)

```json
{
  "type": "worker_completed",
  "sessionId": "worker-456",
  "managerSessionId": "manager-123",
  "task": "Implement feature X",
  "status": "completed",
  "summary": "Implemented the feature and opened a PR",
  "output": "Full session output...",
  "errors": [],
  "timestamp": 1234567890
}
```

### Worker to Manager (Progress Update)

```json
{
  "type": "progress_update",
  "sessionId": "worker-456",
  "managerSessionId": "manager-123",
  "progress": "Created the initial files and wrote basic tests",
  "blockingIssues": ["Need clarification on API design"],
  "timestamp": 1234567890
}
```

### Worker to Manager (Clarification Request)

```json
{
  "type": "clarification_request",
  "sessionId": "worker-456",
  "managerSessionId": "manager-123",
  "question": "What database should be used for caching?",
  "context": "Currently implementing the caching layer, need to choose between Redis and Memcached",
  "timestamp": 1234567890
}
```

## Worker Session Management

### Creating a Worker Session

```javascript
// Manager creates worker session
const workerSessionId = `worker-${managerSessionId}-${Date.now()}`;
const workerSessionFile = path.join(configDir, "sessions", `${workerSessionId}.jsonl`);

const worker = new SubAgent(
  workerSessionId,
  workerSessionFile,
  managerInstance,
  {
    role: "worker",
    task: task,
    acceptanceCriteria: acceptanceCriteria,
    workDirectories: workDirectories,
  }
);
```

### Worker Reporting

When worker completes or needs to report:

```javascript
// Worker calls summarize_and_report tool
async function summarize_and_report(args) {
  const summary = {
    type: "worker_completed",
    sessionId: this.sessionId,
    managerSessionId: this.managerSessionId,
    task: this.task,
    status: args.status,
    summary: args.summary,
    output: this.output,
    errors: this.errors,
  };
  
  // Write to session file
  fs.appendFileSync(this.sessionFile, JSON.stringify(summary) + "\n");
  
  // Notify manager
  if (this.managerAgent && this.managerAgent.receiveSubAgentResult) {
    await this.managerAgent.receiveSubAgentResult(summary);
  }
  
  return { success: true };
}
```

## Resume Support for Subagents

### Session Stack

The manager should maintain a stack of subagent session IDs:

```javascript
// In session config
config.subagentSessionStack = [
  {
    sessionId: "worker-789",
    startedAt: Date.now(),
    completed: false,
    workDirectories: ["/path/to/repo"],
  }
];
```

### Resuming the Latest Subagent

```javascript
async function resumeLatestSubagent(managerSessionId) {
  // Load manager session config
  const config = loadSessionConfig(managerSessionId);
  
  if (!config.subagentSessionStack || config.subagentSessionStack.length === 0) {
    throw new Error("No subagent sessions to resume");
  }
  
  // Get the most recent incomplete subagent
  const subagentStack = config.subagentSessionStack;
  const latestSubagent = subagentStack
    .slice()
    .reverse()
    .find(s => !s.completed);
  
  if (!latestSubagent) {
    log("All subagents completed");
    return { complete: true };
  }
  
  // Resume the subagent with its session file
  const subagent = new SubAgent(
    latestSubagent.sessionId,
    `sessions/${latestSubagent.sessionId}.jsonl`,
    managerInstance,
    {
      role: "worker",
      workDirectories: latestSubagent.workDirectories,
    }
  );
  
  // Continue from the last message
  await subagent.resume(latestSubagent.resumeContext || "Continue from last progress point");
  
  return { resumed: true, sessionId: latestSubagent.sessionId };
}
```

## Error Handling in Manager-Worker Pattern

### Worker Failure

If a worker fails, the manager should:

1. Log the error
2. Optionally restart the worker with feedback
3. If repeated failures occur, escalate to user

```javascript
async function handleWorkerFailure(workerId, error) {
  this.errors.push({
    workerId,
    error: error.message,
    timestamp: Date.now(),
  });
  
  const errorCount = this.errors.filter(e => e.workerId === workerId).length;
  
  if (errorCount >= 3) {
    // Too many failures, notify user
    await this.notifyUser(`Worker ${workerId} has failed ${errorCount} times. Manual intervention may be required.`);
  } else {
    // Retry with feedback
    const feedback = `Previous attempt failed with: ${error.message}\n\nPlease try again.`;
    await this.restartWorker(workerId, feedback);
  }
}
```

### Quota Error in Worker

When a worker hits quota:

```javascript
async function handleWorkerQuotaError(workerId, quotaError) {
  // Store worker state
  const worker = this.workerAgents.get(workerId);
  
  // Update subagent stack
  const stackIndex = this.subagentSessionStack.findIndex(s => s.sessionId === workerId);
  if (stackIndex >= 0) {
    this.subagentSessionStack[stackIndex] = {
      ...this.subagentSessionStack[stackIndex],
      lastError: quotaError,
      pausedAt: Date.now(),
    };
  }
  
  // Schedule resume with quota reset time
  const resumeAt = Date.now() + quotaError.resetAfterMs;
  scheduleTask(`resume_worker:${workerId}`, resumeAt, "quota_resume");
  
  // Update status
  this.setStatus(`Worker ${workerId} paused due to quota. Resuming at ${new Date(resumeAt).toLocaleString()}`);
}
```

## Tool Extensions for Pi Agent

When using pi-coding-agent, register the subagent communication tools:

```javascript
const subagentTools = [
  defineTool({
    name: "summarize_and_report",
    description: "Submit a summary to the manager agent",
    // ... parameters and implementation
  }),
  defineTool({
    name: "request_clarification",
    description: "Ask the manager for help",
    // ... parameters and implementation
  }),
];

// Add to agent's tool list
const allTools = [...codeTools, ...subagentTools];
```
