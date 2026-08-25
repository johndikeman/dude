---
name: github-cli
description: Access to the GitHub CLI (gh) for git operations, pull requests, issues, and repository management.
---

# GitHub CLI

This skill provides access to the GitHub CLI (`gh`) for git operations and repository management.

## Usage

You can use the `gh` command directly in the shell.

### Authentication Status

\`\`\`bash
gh auth status
\`\`\`

If you're not authenticated, you may need to run:
\`\`\`bash
gh auth login
\`\`\`

Alternatively, you can set the \`GITHUB_TOKEN\` environment variable.

### Common Commands

- **List Pull Requests**: \`gh pr list\`
- **View a Pull Request**: \`gh pr view <number>\`
- **Create a Pull Request**: \`gh pr create --title "Title" --body "Body" --assignee @me\`
  - always pass \`--assignee @me\` so the pr shows up in the owner's assigned list in the github app. if the token lacks scopes for \`gh pr edit --add-assignee\`, use the rest api instead: \`gh api -X POST repos/{owner}/{repo}/issues/<number>/assignees -f assignees[]=<user>\`
- **List Issues**: \`gh issue list\`
- **Clone a Repository**: \`gh repo clone <owner>/<repo>\`

### Git Operations

Standard \`git\` commands are also available. GitHub CLI integrates with Git to provide a better experience.
