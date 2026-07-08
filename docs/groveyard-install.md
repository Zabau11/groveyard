# Groveyard Install And Use

Groveyard is a local stdio MCP server for coding agents. It gives agents isolated Git worktree sessions, scoped file access, approved command profiles, status/diff review, and cleanup.

## Local Build

From this repository:

```bash
npm install
npm run build:groveyard
```

The local server entrypoint is:

```text
packages/worktree-mcp/dist/index.js
```

## Smoke Test

Run the human CLI first:

```bash
node packages/worktree-mcp/dist/index.js doctor --repo .
node packages/worktree-mcp/dist/index.js sessions --repo .
```

Expected shape:

```text
Groveyard doctor: ok
Repo: /path/to/repo
Config: defaults
Worktrees: .agent-worktrees
Branch prefix: agent/
Dirty base: rejected
Command profiles: none
```

Running without a subcommand starts the MCP stdio server:

```bash
node packages/worktree-mcp/dist/index.js
```

That mode waits for an MCP client and will not print normal terminal output.

## Repository Config

Run `groveyard init` in any repo where agents should work:

```bash
groveyard init
groveyard doctor
groveyard dashboard
```

It detects common npm scripts such as `test`, `build`, `lint`, and `typecheck`, then writes `.groveyard.yml`.

`groveyard dashboard` shows the current repo branch, whether the base checkout is dirty, configured command profiles, detected MCP client configs, active session counts, and the latest sessions under the Groveyard ASCII logo.

You can also create `.groveyard.yml` manually:

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

Use this server config in an MCP-capable agent after publishing:

```json
{
  "mcpServers": {
    "groveyard": {
      "command": "npx",
      "args": ["-y", "@groveyard/mcp"]
    }
  }
}
```

For local development before publishing:

```json
{
  "mcpServers": {
    "groveyard": {
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
commit_session
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
7. commit_session({ message }) to commit the session branch
8. cleanup_session when the user is done with the worktree
```

## Human CLI

After an agent creates sessions, inspect them from a terminal:

```bash
npx -y @groveyard/mcp init --repo .
npx -y @groveyard/mcp sessions --repo .
npx -y @groveyard/mcp inspect <sessionId> --repo .
npx -y @groveyard/mcp commit <sessionId> -m "message" --repo .
npx -y @groveyard/mcp clean <sessionId> --repo .
```

Add `--json` for machine-readable output:

```bash
npx -y @groveyard/mcp inspect <sessionId> --repo . --json
```

## Notes

- Groveyard stores session metadata in `.groveyard/sessions.json`.
- Worktrees are created under the configured `worktreesRoot`.
- File tools reject absolute paths, `..` escapes, and unsafe symlink escapes.
- `git_diff` includes modified tracked files and untracked new files.
- `cleanup_session` only removes registered worktrees owned by the configured worktree root.
