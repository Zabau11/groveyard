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

Path-safe file access, Git inspection tools, and command profiles are the next implementation steps.
