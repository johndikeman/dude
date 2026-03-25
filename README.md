# Self-Improving AI Agent

This agent uses `pi-mono-agent` (coding agent harness) to perform tasks on its own codebase or other projects.

## Tech Stack
- **pi-mono-agent**: The underlying coding agent.
- **Nix Flakes**: For dependency management.
- **Discord.js**: For communication with the user.
- **Google Cloud SDK**: For Gemini API authentication.
- **GitHub CLI (gh)**: For creating Pull Requests.

## Prerequisites
1. A Discord Bot Token.
2. Google AI subscription and `gcloud` authenticated.
3. GitHub personal access token configured for `gh`.

## Setup
1. Clone this repository on your VPS.
2. Ensure Nix is installed with Flakes enabled.
3. Create a `.env` file based on `.env.example` and add your `DISCORD_TOKEN`.
4. Run `nix develop` to enter the shell with all dependencies.
5. Authenticate `gcloud`:
   ```bash
   gcloud auth login
   gcloud config set project <YOUR_PROJECT_ID>
   ```
6. Authenticate `gh`:
   ```bash
   gh auth login
   ```
7. Start the agent:
   ```bash
   npm start
   ```

## Discord Commands
- `!task <description>`: Add a new task to the queue.
- `!tasks`: List all pending tasks.
- `!status`: Show current working directory and queue status.
- `!workdir <path>`: Change the directory where the agent works.
- `!start`: Start working on the next task in the queue.
- `!restart`: Stop the agent (use with a process manager like `systemd` or `pm2` to auto-restart).

## Self-Improvement
The agent can modify its own code in `src/` and `flake.nix`. When it completes a task, it will automatically:
1. Create a new git branch.
2. Commit the changes.
3. Push to GitHub.
4. Open a Pull Request.
