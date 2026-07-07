# Worktree MCP

Safe Git worktree sessions for coding agents.

This package provides a local stdio MCP server that lets MCP-capable coding agents create isolated Git worktree sessions, inspect diffs, run approved commands, and clean up after a task.

Full install and MCP client setup docs live in [../../docs/worktree-mcp-install.md](../../docs/worktree-mcp-install.md).

## Development

```bash
npm install
npm run dev:worktree-mcp
npm run build:worktree-mcp
```

Smoke test:

```bash
node /Users/david/Documents/orchestrator/packages/worktree-mcp/dist/index.js doctor --repo .
node /Users/david/Documents/orchestrator/packages/worktree-mcp/dist/index.js sessions --repo .
```

## CLI

Running `worktree-mcp` without a subcommand starts the stdio MCP server. Human debugging commands are also available:

```bash
worktree-mcp doctor
worktree-mcp sessions
worktree-mcp inspect <sessionId>
worktree-mcp clean <sessionId>
```

Each command accepts `--repo <path>` and `--json`.

## Configuration

Repositories can define `.worktree-mcp.yml`:

```yaml
worktreesRoot: .agent-worktrees
branchPrefix: agent/
allowDirtyBase: false
commands:
  test: npm test
  lint: npm run lint
  build: npm run build
```

If no config exists, Worktree MCP uses the conservative defaults above with no command profiles enabled.

## Current Status

The package has a minimal MCP server entrypoint and the first worktree lifecycle tools:

- `server_info`
- `create_session`
- `list_sessions`
- `get_session`
- `cleanup_session`
- `git_status`
- `git_diff`
- `read_file`
- `write_file`
- `list_files`
- `run_command_profile`

Tool responses use a consistent JSON envelope:

```json
{
  "ok": true,
  "tool": "git_status",
  "data": {},
  "nextSteps": []
}
```

Command profiles are loaded from `.worktree-mcp.yml` and run without shell evaluation:

```yaml
commands:
  test: npm test
  lint: npm run lint
  build: npm run build
```
