# Groveyard

**Persistent, isolated workspaces for coding agents.**

Groveyard is an open-source MCP server that gives Codex, Claude Code, VS Code, and other coding agents a safe Git workspace for each task. It keeps agent work off your main checkout, preserves it across new chats and apps, and gives you a reviewable branch when the task is done.

```bash
npx -y @groveyard/mcp setup
```

## Why Groveyard?

Agent chats are disposable. Your workspaces should not be.

Without Groveyard, a new agent thread can lose track of the branch it was using, edit the wrong checkout, or create duplicate worktrees. Groveyard keeps the task, branch, and workspace together even when you close a chat and return later.

```text
New task
→ isolated Git worktree
→ agent edits and validates it
→ you review a dedicated branch
→ a new chat can resume the same session
```

## Start here

Run setup from the Git repository where you use coding agents:

```bash
npx -y @groveyard/mcp setup
```

Groveyard detects your coding app, installs a repo-specific MCP connection and native agent instructions, creates a small setup commit, and verifies the connection.

Then use your agent normally:

```text
You: Refine the website palette.
Agent: Groveyard creates an isolated workspace and branch.

You: Keep refining the palette.
Agent: Groveyard resumes the existing session—even in a new chat.
```

For a permanent terminal command:

```bash
npm install -g @groveyard/mcp
groveyard sessions
```

## What it does

- Creates or adopts isolated Git worktrees for code-changing tasks.
- Tracks sessions across Codex, Claude Code, VS Code, Cursor, Gemini CLI, OpenCode, and other MCP clients.
- Resumes the right active or completed session in a new agent conversation.
- Requires review of status and diff before a session is committed.
- Keeps managed and adopted workspaces safely separate: Groveyard removes only worktrees it created.
- Cleans completed worktrees after their branch is merged into `main`, `dev`, or another configured target.

Useful commands:

```bash
groveyard doctor
groveyard sessions
groveyard inspect <session-id>
groveyard clean <session-id>
```

## Open source and contributing

Groveyard is MIT-licensed and built in public. Issues, bug reports, docs improvements, client-adapter support, and workflow feedback are all welcome.

To contribute:

1. Fork the repository and create a feature branch from `dev`.
2. Install dependencies and run the relevant checks:

   ```bash
   npm install
   npm run test:groveyard
   npm run typecheck
   ```

3. Open a pull request into `dev` with a clear description and tests for behavior changes.
4. A maintainer reviews the PR before it is merged.

Please do not push directly to `main` or `dev`; protected branches are merged through pull requests.

## Development

```bash
npm install
npm run build:groveyard
npm run test:groveyard
npm run build:web
```

The MCP package lives in [`packages/worktree-mcp`](packages/worktree-mcp). Installation and client-configuration details are in [the installation guide](docs/groveyard-install.md).

## License

[MIT](LICENSE) © 2026 Groveyard contributors.
