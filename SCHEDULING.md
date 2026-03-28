# Quota Error Handling and Scheduling System

## Overview

The dude agent now includes a flexible scheduling system that can detect Google API quota errors and automatically pause and resume tasks when the quota resets.

## Quota Error Detection

The system automatically detects quota errors from the Google Gemini CLI by looking for the following patterns:
- HTTP 429 status codes
- Error messages containing "exhausted your capacity" or "quota"

Example error message format:
```
Cloud Code Assist API error (429): You have exhausted your capacity on this model. Your quota will reset after 3h50m3s.
```

## Automatic Mitigation

When a quota error is detected:
1. The current task is paused and stored in `schedule.json`
2. A resume time is calculated based on the error message's reset time
3. The task is scheduled to resume when the quota resets
4. Discord status is updated to show the task is paused

## Manual Scheduling

You can manually schedule tasks using Discord slash commands:

### `/schedule <task> <time>`

Schedule a task to run at a specific time.

**Time formats:**
- Relative: `5m`, `1h`, `2h30m`, `1h30m0s`
- Absolute: `14:30` (scheduled for tomorrow if time has passed)

**Example:**
```
/schedule implement feature X 1h
```

### `/paused`

List all paused tasks and when they will resume.

### `/scheduled`

List all scheduled tasks.

### `/resume <id>`

Resume a paused task immediately (before quota reset).

### `/cancel <id> [type]`

Cancel a paused or scheduled task.

**Type options:**
- `paused` - cancel a paused task
- `scheduled` - cancel a scheduled task
- (omit) - tries both types

## Configuration

The schedule is stored in `schedule.json`:

```json
{
  "paused": [
    {
      "id": "1774731136003",
      "task": "implement feature X",
      "pausedAt": 1774731136003,
      "resumeAt": 1774731196003,
      "errorInfo": {
        "type": "quota_exhausted",
        "resetAfterMs": 60000,
        "errorMessage": "..."
      }
    }
  ],
  "scheduled": [
    {
      "id": "1774731200000",
      "task": "implement feature Y",
      "scheduledAt": 1774731200000,
      "runAt": 1774734800000,
      "reason": "manual"
    }
  ]
}
```

## Scheduling Internals

- **Check Interval**: The agent checks for ready scheduled tasks every 5 minutes
- **Startup Check**: On startup, the agent checks and runs any pending scheduled tasks
- **Auto-Resume**: Paused tasks are automatically added back to the task queue when the quota resets

## Discord Status Updates

When a task is paused due to quota:
- Discord status shows: "Quota exhausted. Pausing task until Xm Ys."
- When resume happens: "Found X paused task(s) ready to resume"

## Testing

Run tests:
```bash
npm test
npm run test:scheduler
npm run test:index
```

## API Reference

### scheduler.js

#### `parseTimeString(timeStr)`
Parse time strings like "3h50m3s" or "24m26s" into milliseconds.

#### `parseQuotaError(errorMessage)`
Parse a quota error message and return reset time info.

#### `isQuotaError(output)`
Check if output contains a quota error.

#### `pauseTask(task, errorInfo)`
Pause a task and schedule resume time.

#### `scheduleTask(task, runAt, reason)`
Schedule a task for a specific time.

#### `getReadyTasks()`
Get tasks that are ready to resume/run.

#### `listPausedTasks()` / `listScheduledTasks()`
Get human-readable lists of scheduled/paused tasks.

#### `cancelPausedTask(taskId)` / `cancelScheduledTask(taskId)`
Cancel a paused or scheduled task.
