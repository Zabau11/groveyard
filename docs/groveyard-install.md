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

It also writes `.groveyard/AGENTS.md` with the agent-facing session policy, enforced contract, recommended workflow, and completion checklist. Give this file to coding agents or reference it from your agent instructions so every code-changing task starts in a fresh Groveyard session.

Session state is reconciled automatically when Groveyard lists, inspects, or uses sessions. A clean session branch with commits becomes `completed`; if that branch is already merged into a configured target branch, Groveyard removes the worktree and marks the session `cleaned`.

`groveyard dashboard` shows the current repo branch, whether the base checkout is dirty, configured command profiles, detected MCP client configs, active session counts, and the latest sessions under the Groveyard ASCII logo.

You can also create `.groveyard.yml` manually:

```yaml
worktreesRoot: .agent-worktrees
branchPrefix: agent/
allowDirtyBase: false
autoCleanBranches:
  - main
  - master
  - dev
  - develop
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

Prefer `groveyard connect --repo .` when possible. It writes or prints MCP config with a repo-scoped server name such as `groveyard_orchestrator`, plus both `GROVEYARD_REPO` and `GROVEYARD_AGENT_INSTRUCTIONS`, where `GROVEYARD_AGENT_INSTRUCTIONS` points at `.groveyard/AGENTS.md`. Add the printed instruction line to your agent's custom instructions when the client has a separate prompt/settings field. Use `--name <server>` to choose a stable server name explicitly.

Use this server config in an MCP-capable agent after publishing:

```json
{
  "mcpServers": {
    "groveyard_orchestrator": {
      "command": "npx",
      "args": ["-y", "@groveyard/mcp"],
      "env": {
        "GROVEYARD_REPO": "/Users/david/Documents/orchestrator",
        "GROVEYARD_AGENT_INSTRUCTIONS": "/Users/david/Documents/orchestrator/.groveyard/AGENTS.md"
      }
    }
  }
}
```

For local development before publishing:

```json
{
  "mcpServers": {
    "groveyard_orchestrator": {
      "command": "node",
      "args": [
        "/Users/david/Documents/orchestrator/packages/worktree-mcp/dist/index.js"
      ],
      "env": {
        "GROVEYARD_REPO": "/Users/david/Documents/orchestrator",
        "GROVEYARD_AGENT_INSTRUCTIONS": "/Users/david/Documents/orchestrator/.groveyard/AGENTS.md"
      }
    }
  }
}
```

If the client supports setting a working directory, set it to the repository you want to manage. Otherwise, pass `repoPath` when calling tools.

Important: `repoPath` is resolved by the Groveyard MCP server process, not by the agent process making the tool call. For normal local MCP use, run Groveyard as a stdio server through `npx -y @groveyard/mcp` with the server `cwd` set to your repository, set `GROVEYARD_REPO`, or pass an absolute path that exists on the same machine/container where Groveyard is running. If an MCP host runs tools in a separate remote sandbox, mount/clone the repository into that server environment first.

## First Agent Workflow

Groveyard's default policy is implementation-mode isolation: create a fresh session for every code-changing task before reading, writing, running project commands, committing, or reporting implementation work. Do not create a session for read-only questions, explanations, planning, status checks, or reviews that will not modify files.

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
7. contract_status to confirm the enforced checklist is clear
8. commit_session({ message }) to commit the session branch
9. cleanup_session when the user is done with the worktree
```

Groveyard enforces the agent contract at runtime. Session-scoped tools reject inactive or cleaned sessions, `write_file` refuses to overwrite an existing file until that file has been read through `read_file`, and `commit_session` refuses to commit until `git_status` and `git_diff` have both run after the latest write or command profile.

Users normally should not need to manually clean sessions after merged work. Groveyard checks Git state during ordinary session reads and retires sessions when it can prove their clean branch has landed in `autoCleanBranches`.

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
