# Groveyard

Groveyard is an open-source MCP server that gives every coding-agent task an isolated, persistent, reviewable Git workspace—inside Codex, Claude Code, VS Code, and the tools you already use.

Agent chats are disposable. Groveyard keeps the task's branch and workspace available when you return in a new chat or a different coding app.

## Start here

Run this from the Git repository where your coding agent works:

```bash
npx -y @groveyard/mcp setup
```

Setup detects the current coding app when possible, configures its personal repo-specific MCP entry, installs the app's native repository instructions, and verifies the repository, client configuration, session store, and MCP handshake.

```text
✓ Found repository
✓ Detected VS Code
✓ Installed Groveyard MCP
✓ Added agent instructions
✓ Verified connection

Groveyard is ready.
Restart VS Code and ask your agent to implement a task.
```

If several apps are installed, Groveyard configures one primary app and shows how to add the others:

```bash
npx -y @groveyard/mcp setup --client vscode
npx -y @groveyard/mcp setup --client codex --client claude-code
npx -y @groveyard/mcp setup --all
```

Use `--json` for one machine-readable report, `--yes` for explicit headless automation, `--no-instructions` to skip native instruction blocks, and `--force` to regenerate `.groveyard.yml`. Existing valid `.groveyard.yml` content is preserved byte-for-byte by default.

Check the installed version and updater status with:

```bash
groveyard --version
groveyard upgrade --check
groveyard upgrade
```

For a one-time latest run without installing globally:

```bash
npx -y @groveyard/mcp@latest setup
```

## What the agent does

You: Fix the authentication timeout and run the tests.

Agent:

```text
✓ Groveyard session started
✓ Working in an isolated workspace
✓ Validation passed
✓ Session ready to merge
```

The primary MCP lifecycle is:

- `list_sessions` discovers active and completed work before a new session is created.
- `resume_session` reopens a completed, unmerged session on the same branch and workspace.
- `start_session` creates a managed worktree from the main checkout or adopts an existing linked worktree for a clearly new task.
- `session_status` reports the current workspace state.
- `validate_session` reviews status, diff, and the completion contract.
- `finish_session` produces the handoff state without deleting work.
- `cleanup_session` removes managed worktrees or merely releases adopted worktrees.

`create_session` remains as a compatibility alias that always creates a managed worktree.

## Safety

Setup parses before writing, preserves unrelated client settings, writes atomically, creates a `.groveyard-backup` before changing existing client configuration, and never overwrites malformed configuration. Repeated setup keeps one Groveyard entry and one managed instruction block.

Managed and adopted sessions have explicit ownership:

- Groveyard may stop processes and remove a worktree it created.
- Groveyard never removes an adopted checkout, branch, files, or processes.

## Advanced commands

```bash
groveyard doctor
groveyard connect claude-code
groveyard init
groveyard dashboard
groveyard sessions
groveyard inspect <sessionId>
groveyard clean <sessionId>
```

Configuration details and troubleshooting are in [the installation guide](../../docs/groveyard-install.md).

## Open source and contributing

Groveyard is MIT-licensed and developed in public. Contributions are welcome: bug reports, workflow feedback, documentation, tests, and support for additional coding clients.

1. Fork the repository and branch from `dev`.
2. Run the checks below.
3. Open a pull request into `dev` with a concise description and tests for behavior changes.

Protected branches are merged through reviewed pull requests; do not push directly to `main` or `dev`.

## Development

```bash
npm install
npm run build:groveyard
npm run test:groveyard
```

## License

[MIT](LICENSE) © 2026 Groveyard contributors.
