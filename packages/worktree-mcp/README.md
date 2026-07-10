# Groveyard

Groveyard gives every coding-agent task an isolated, validated, disposable Git workspace—inside Codex, Claude Code, VS Code, and the tools you already use.

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

The scoped package remains available for compatibility:

```bash
npx -y @groveyard/mcp setup
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

- `start_session` creates a managed worktree from the main checkout or adopts an existing linked worktree.
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

## Development

```bash
npm install
npm run build:groveyard
npm run test:groveyard
```
