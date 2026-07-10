# Groveyard

Groveyard gives every coding-agent task an isolated, validated, disposable Git workspace—inside Codex, Claude Code, VS Code, and the tools you already use.

```bash
npx -y @groveyard/mcp setup
```

Setup configures the current coding app, installs repository instructions, and verifies that Groveyard is usable. Then restart the app and give your agent a code-changing task.

The MCP implementation lives in [`packages/worktree-mcp`](packages/worktree-mcp).

## Development

```bash
npm install
npm run build:groveyard
npm run test:groveyard
npm run build:web
```
