# Groveyard

Safe Git worktree sessions for coding agents.

This package provides a local stdio MCP server that lets MCP-capable coding agents create isolated Git worktree sessions, inspect diffs, run approved commands, and clean up after a task.

Full install and MCP client setup docs live in [../../docs/groveyard-install.md](../../docs/groveyard-install.md).

## Development

```bash
npm install
npm run dev:groveyard
npm run build:groveyard
```

Smoke test:

```bash
node packages/worktree-mcp/dist/index.js doctor --repo .
node packages/worktree-mcp/dist/index.js sessions --repo .
```

## CLI

Running `groveyard` without a subcommand starts the stdio MCP server. Human debugging commands are also available:

```bash
groveyard init
groveyard doctor
groveyard connect
groveyard sessions
groveyard inspect <sessionId>
groveyard commit <sessionId> -m "message"
groveyard clean <sessionId>
```

Each command accepts `--repo <path>` and `--json`.
Use `groveyard connect` to detect Codex, Claude Desktop, and Cursor config files, then confirm whether Groveyard should create or update them. In non-interactive terminals it prints ready-to-paste snippets instead. Use `groveyard connect --yes` to write detected configs without prompts.

## Configuration

Run `groveyard init` to create `.groveyard.yml` automatically. It detects common npm scripts, turns them into safe command profiles, and adds Groveyard's generated folders to `.gitignore`. In an interactive terminal, `init` and `doctor` use small spinners and colored output; in CI or JSON mode, they stay plain.

Repositories can also define `.groveyard.yml` manually:

```yaml
worktreesRoot: .agent-worktrees
branchPrefix: agent/
allowDirtyBase: false
commands:
  test: npm test
  lint: npm run lint
  build: npm run build
```

If no config exists, Groveyard uses the conservative defaults above with no command profiles enabled.

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
- `commit_session`

Tool responses use a consistent JSON envelope:

```json
{
  "ok": true,
  "tool": "git_status",
  "data": {},
  "nextSteps": []
}
```

Command profiles are loaded from `.groveyard.yml` and run without shell evaluation:

```yaml
commands:
  test: npm test
  lint: npm run lint
  build: npm run build
```
