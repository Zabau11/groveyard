# Worktree MCP

Safe Git worktree sessions for coding agents.

This package will provide a local stdio MCP server that lets MCP-capable coding agents create isolated Git worktree sessions, inspect diffs, run approved commands, and clean up after a task.

## Development

```bash
npm install
npm run dev:worktree-mcp
npm run build:worktree-mcp
```

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

Command profiles are the next implementation step.
