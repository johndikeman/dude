# Dude Agent - Repository Brief

## Purpose
`dude` is a self-improving AI agent. It is a Discord bot that manages a task list in `tasks.md` and uses `pi-mono-agent` (the `pi` command) to execute tasks on its own codebase or external repositories.

## Key Components
- **`src/index.js`**: Entry point. It handles Discord slash commands, manages the task list, and spawns the `pi` agent process with a custom prompt.
- **`tasks.md`**: A markdown file that serves as a task queue. Tasks are added via `/task` and marked as done by the agent upon completion.
- **`package.json`**: Project metadata and dependencies (Discord.js, dotenv, etc.).
- **`flake.nix` & `flake.lock`**: Nix configuration for environment reproducibility.
- **`config.json`**: Local configuration storing the current working directory (`workDir`).

## Workflow
1. **Task Addition**: Users add tasks via the `/task` slash command in Discord.
2. **Task Execution**: The `/start` command triggers the agent to take the first pending task from `tasks.md`.
3. **Agent Spawn**: `src/index.js` spawns a `pi` process using `google-gemini-cli`. The prompt provides context about the task, working directory, and self-improvement goals.
4. **Implementation**: The `pi` agent works on the task, reporting progress via `[STATUS]` lines that are sent back to Discord.
5. **Completion**: The agent is expected to:
    - Create a feature branch.
    - Implement and test changes.
    - Commit and open a PR via `gh`.
    - Mark the task as done in `tasks.md`.
6. **PR Review**: The owner reviews and merges the PR.

## Tech Stack
- **Language**: Node.js
- **Harness**: `pi-mono-agent`
- **Environment**: Nix (Flakes)
- **Communication**: Discord.js
- **LLM**: Gemini (via `google-gemini-cli`)
- **Version Control**: Git & GitHub CLI (`gh`)

## Common Operations
- `/status`: Check current workDir and task queue.
- `/workdir <path>`: Update the directory where the agent operates.
- `/clone <repo>`: Clone a new repository and set it as the workDir.
- `/restart`: Restarts the process (useful for applying updates).
