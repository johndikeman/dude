# Quota Handling Skill

This skill provides utilities for handling API quota errors during agent execution.

## Quota Error Detection

To detect quota errors in output:

```javascript
function isQuotaError(output) {
  // Check for 429 status and quota-related messages
  const has429 = output.includes("429");
  const hasCapacityError = output.includes("exhausted your capacity") || 
                           output.includes("No capacity available");
  const hasQuotaReset = output.includes("quota will reset") || 
                        output.includes("Quota exhausted") ||
                        output.includes("quota limit reached");
  
  return has429 && (hasCapacityError || hasQuotaReset);
}
```

## Parsing Quota Error Reset Time

To extract reset time from quota error messages:

```javascript
function parseQuotaErrorResetTime(errorMessage) {
  const timeMatch = errorMessage.match(/quota will reset after ([0-9]+h)?([0-9]+m)?([0-9]+s)?/i);
  
  if (timeMatch) {
    const timeStr = timeMatch[0].replace(/quota will reset after /i, "");
    return parseTimeToMs(timeStr);
  }
  
  return 3600000; // Default 1 hour if no time specified
}

function parseTimeToMs(timeStr) {
  if (!timeStr) return 3600000;
  
  const hoursMatch = timeStr.match(/(\d+)h/);
  const minutesMatch = timeStr.match(/(\d+)m/);
  const secondsMatch = timeStr.match(/(\d+)s/);
  
  const hours = hoursMatch ? parseInt(hoursMatch[1], 10) : 0;
  const minutes = minutesMatch ? parseInt(minutesMatch[1], 10) : 0;
  const seconds = secondsMatch ? parseInt(secondsMatch[1], 10) : 0;
  
  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}
```

## Handling a Quota Error

When a quota error is detected:

1. **With fallback model enabled**: 
   - Store current session state
   - Re-queue the task with fallback model indicator
   - Resume with fallback model
   
2. **Without fallback model**:
   - Calculate resume time from error message
   - Move task to paused queue
   - Schedule resume after quota reset

```javascript
async function handleQuotaError(errorInfo, task) {
  if (USE_FALLBACK_MODEL && FALLBACK_MODEL_CODE) {
    // Switch to fallback model
    log(`Switching to fallback model: ${FALLBACK_MODEL_CODE}`);
    
    // Store session info for resume
    SESSIONS.updateSession(currentSessionId, {
      lastModel: MODEL_CODE,
      fallbackModelUsed: FALLBACK_MODEL_CODE,
      lastModelError: errorInfo.errorMessage,
    });
    
    // Re-queue task for retry
    addTask(`[FALLBACK_RETRY] Original: ${task}\nPrevious error: ${errorInfo.errorMessage}`);
  } else {
    // Pause task until quota resets
    const resumeAt = Date.now() + errorInfo.resetAfterMs;
    
    pauseTask(task, errorInfo);
    scheduleTask(task, resumeAt, "quota_resume");
    
    // Update status
    currentStatus = `Quota exhausted. Pausing for ${formatDuration(errorInfo.resetAfterMs)}`;
  }
}
```

## Session Resumption

When resuming from a quota pause:

1. Load the session from the session file
2. Use the same model if possible, or use fallback
3. Continue from the last message in the session

```javascript
async function resumeFromQuotaPause(task, sessionInfo) {
  const sessionFilePath = sessionInfo.sessionFile;
  
  if (!fs.existsSync(sessionFilePath)) {
    throw new Error("Session file not found for resumption");
  }
  
  // Load session context
  const sessionContext = loadSessionContext(sessionFilePath);
  
  // Create new session with continuation
  const options = {
    ...sessionInfo,
    resumeContext: {
      previousError: sessionInfo.errorInfo?.errorMessage,
      lastModel: sessionInfo.lastModel,
    },
  };
  
  await startAgentSession(task, options);
}
```

## Best Practices

1. Always save session state before any model call
2. Include detailed error information when pausing
3. Track the model used for each session for proper resumption
4. Provide clear status updates when quota is exhausted
5. Consider user-visible messages about expected resume times
