# Groveyard Product Contract

## Product Promise

Groveyard gives AI coding agents safe, disposable Git workspaces.

An agent connects through MCP, asks for a session, works inside an isolated Git worktree, runs approved checks, returns a diff, and leaves the user's main checkout clean.

## Target User

The first user is a developer using one or more local coding agents such as Codex, Claude Code, Cursor, or similar tools against an existing Git repository.

They want agents to make code changes without:

- dirtying the main checkout;
- fighting over the same branch;
- leaving mystery worktrees behind;
- editing files outside the intended repo;
- requiring the user to manually remember Git worktree commands.

## Core Workflow

```text
1. Agent calls create_session for a coding task.
2. Server creates a Git worktree on a new session branch.
3. Agent reads and writes files through session-scoped tools.
4. Agent runs approved command profiles such as test, lint, or build.
5. Agent calls git_status and git_diff before reporting completion.
6. User reviews the diff, then commits, promotes, or cleans up the session.
```

## MVP Scope

The MVP is a local stdio MCP server with a small session registry and Git worktree lifecycle tools.

Required MCP tools:

- `create_session`: create an isolated Git worktree for a task.
- `list_sessions`: list active and completed sessions.
- `get_session`: inspect one session's metadata.
- `cleanup_session`: remove a session worktree safely.
- `read_file`: read a file inside a session worktree.
- `write_file`: write a file inside a session worktree.
- `git_status`: return `git status --short` for a session.
- `git_diff`: return the current patch for a session.
- `run_command_profile`: run a named command from repo config inside the session.

## Explicit Non-Goals

The first version will not:

- plan or split tasks across multiple agents;
- merge or compose multiple agents' patches;
- expose unrestricted shell execution;
- push branches or open pull requests;
- manage remote runners or cloud sandboxes;
- replace a coding agent's own editor or terminal tools.

These can be added later after the local session broker is useful and safe.

## Safety Guarantees

The server must enforce these guarantees before it is considered usable:

- Every session maps to exactly one worktree root.
- File reads and writes must stay inside that session worktree.
- User-provided paths must be normalized and checked before use.
- Branch names and session paths must be generated or sanitized by the server.
- Commands must be selected from an allowlist, not arbitrary shell strings.
- Cleanup must only remove registered worktrees owned by the server.
- Tool responses must make it clear which session and worktree were affected.

## Configuration Contract

Each repository may define `.groveyard.yml`.

Initial shape:

```yaml
worktreesRoot: .agent-worktrees
branchPrefix: agent/
allowDirtyBase: false
commands:
  test: npm test
  lint: npm run lint
  build: npm run build
```

If no config exists, the server should use conservative defaults:

- worktrees under `.agent-worktrees`;
- branch prefix `agent/`;
- dirty base checkout rejected;
- no command profiles enabled.

## Session Metadata

Each session should store:

```json
{
  "id": "sess_abc123",
  "repoPath": "/absolute/path/to/repo",
  "worktreePath": "/absolute/path/to/repo/.agent-worktrees/sess_abc123",
  "branch": "agent/fix-checkout-button",
  "baseBranch": "main",
  "taskName": "fix checkout button",
  "status": "active",
  "createdAt": "2026-07-06T12:00:00.000Z",
  "updatedAt": "2026-07-06T12:00:00.000Z"
}
```

The first registry can be a JSON file. SQLite can replace it later if locking or concurrent writers become painful.

## Product Positioning

Short description:

```text
Safe Git worktree sessions for coding agents.
```

Longer description:

```text
Groveyard is a local MCP server that gives coding agents isolated Git worktrees, scoped file access, approved command execution, diff review, and cleanup.
```

## Success Criteria

The first usable version succeeds when:

- a user can add the server to an MCP-capable agent in under five minutes;
- an agent can create a session, edit a file, run an approved test command, show a diff, and clean up;
- failed operations leave understandable errors and no untracked server state;
- path escape attempts and unknown command profiles are rejected by tests.
