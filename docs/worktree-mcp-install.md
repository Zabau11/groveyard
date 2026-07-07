# Worktree MCP Install And Use

Worktree MCP is a local stdio MCP server for coding agents. It gives agents isolated Git worktree sessions, scoped file access, approved command profiles, status/diff review, and cleanup.

## Local Build

From this repository:

```bash
npm install
npm run build:worktree-mcp
```

The server entrypoint is:

```text
/Users/david/Documents/orchestrator/packages/worktree-mcp/dist/index.js
```

## Smoke Test

Run the human CLI first:

```bash
node /Users/david/Documents/orchestrator/packages/worktree-mcp/dist/index.js doctor --repo .
node /Users/david/Documents/orchestrator/packages/worktree-mcp/dist/index.js sessions --repo .
```

Expected shape:

```text
Worktree MCP doctor: ok
Repo: /path/to/repo
Config: defaults
Worktrees: .agent-worktrees
Branch prefix: agent/
Dirty base: rejected
Command profiles: none
```

Running without a subcommand starts the MCP stdio server:

```bash
node /Users/david/Documents/orchestrator/packages/worktree-mcp/dist/index.js
```

That mode waits for an MCP client and will not print normal terminal output.

## Repository Config

Add `.worktree-mcp.yml` to any repo where agents should work:

```yaml
worktreesRoot: .agent-worktrees
branchPrefix: agent/
allowDirtyBase: false
commands:
  test: npm test
  lint: npm run lint
  build: npm run build
```

If your current checkout is dirty and you still want to test session creation, set:

```yaml
allowDirtyBase: true
```

Command profiles are allowlisted. Agents call `run_command_profile` with a profile name such as `test`; they cannot pass arbitrary shell commands.

## MCP Client Config

Use this server config in an MCP-capable agent:

```json
{
  "mcpServers": {
    "worktree-mcp": {
      "command": "node",
      "args": [
        "/Users/david/Documents/orchestrator/packages/worktree-mcp/dist/index.js"
      ]
    }
  }
}
```

If the client supports setting a working directory, set it to the repository you want to manage. Otherwise, pass `repoPath` when calling tools.

## First Agent Workflow

The agent should call tools in this order:

```text
server_info
create_session
list_files
read_file
write_file
run_command_profile
git_status
git_diff
cleanup_session
```

Minimum useful flow:

```text
1. create_session({ repoPath, taskName, baseBranch })
2. read_file/list_files to inspect code
3. write_file to make changes
4. run_command_profile({ profile: "test" }) if configured
5. git_status to summarize changed files
6. git_diff to review the patch
7. cleanup_session when the user is done with the worktree
```

## Human CLI

After an agent creates sessions, inspect them from a terminal:

```bash
node /Users/david/Documents/orchestrator/packages/worktree-mcp/dist/index.js sessions --repo .
node /Users/david/Documents/orchestrator/packages/worktree-mcp/dist/index.js inspect <sessionId> --repo .
node /Users/david/Documents/orchestrator/packages/worktree-mcp/dist/index.js clean <sessionId> --repo .
```

Add `--json` for machine-readable output:

```bash
node /Users/david/Documents/orchestrator/packages/worktree-mcp/dist/index.js inspect <sessionId> --repo . --json
```

## Notes

- Worktree MCP stores session metadata in `.worktree-mcp/sessions.json`.
- Worktrees are created under the configured `worktreesRoot`.
- File tools reject absolute paths, `..` escapes, and unsafe symlink escapes.
- `git_diff` includes modified tracked files and untracked new files.
- `cleanup_session` only removes registered worktrees owned by the configured worktree root.
