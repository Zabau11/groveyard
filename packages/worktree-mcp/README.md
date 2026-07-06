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

The package is scaffolded with a minimal MCP server entrypoint and a `server_info` tool. Session lifecycle, Git worktree management, path-safe file access, and command profiles are the next implementation steps.
