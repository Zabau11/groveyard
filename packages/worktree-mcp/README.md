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
groveyard dashboard
groveyard sessions
groveyard inspect <sessionId>
groveyard commit <sessionId> -m "message"
groveyard clean <sessionId>
```

Each command accepts `--repo <path>` and `--json`.
Use `groveyard connect` to detect Codex, Claude Desktop, and Cursor config files, then confirm whether Groveyard should create or update them. In non-interactive terminals it prints ready-to-paste snippets instead. Use `groveyard connect --yes` to write detected configs without prompts. By default, connect creates a repo-scoped MCP server name such as `groveyard_orchestrator`; pass `--name <server>` to choose the name explicitly.
Generated MCP config includes both `GROVEYARD_REPO` and `GROVEYARD_AGENT_INSTRUCTIONS`; the latter points at `.groveyard/AGENTS.md` so agents can load the repo-local Groveyard rules.

## Configuration

Run `groveyard init` to create `.groveyard.yml` automatically. It detects common npm scripts, turns them into safe command profiles, and adds Groveyard's generated folders to `.gitignore`. In an interactive terminal, `init` and `doctor` use small spinners and colored output; in CI or JSON mode, they stay plain.

`groveyard init` also writes `.groveyard/AGENTS.md`, a repo-local agent instruction file containing the session policy, enforced contract, workflow, and completion checklist. Point coding agents at this file so every code-changing task starts with a fresh Groveyard session.

Groveyard reconciles session state automatically whenever sessions are listed, inspected, or used. Clean sessions with commits become `completed`; clean sessions whose branches are already merged into a configured target branch are removed and marked `cleaned`. When a session completes or is cleaned, Groveyard also stops processes whose current working directory is inside that session worktree.

Repositories can also define `.groveyard.yml` manually:

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
  "guidance": {},
  "nextSteps": []
}
```

`server_info` returns the recommended agent workflow, the Groveyard agent contract, and a completion checklist. The contract tells agents to create a fresh Groveyard session for every code-changing task, while skipping session creation for read-only questions, explanations, planning, status checks, and reviews that will not modify files. `create_session` also returns session-specific next steps so coding agents know to work only inside the returned `worktreePath`, use the returned `sessionId`, inspect `git_status` and `git_diff`, and avoid committing or cleaning up unless the user asks.

The contract is enforced by the server, not just described in prompts:

- Session-scoped tools require a registered active session.
- Existing files must be read with `read_file` before `write_file` can overwrite them.
- `commit_session` refuses to commit until `git_status` and `git_diff` have both run after the latest write or command profile.
- `contract_status` reports the current checklist and required actions.
- Session state is reconciled from Git automatically, so users do not need a separate cleanup command in the normal merged-branch path.

MCP clients can also discover the same playbook through:

- Resource: `groveyard://instructions`
- Prompt: `groveyard_session_workflow`

Command profiles are loaded from `.groveyard.yml` and run without shell evaluation:

```yaml
commands:
  test: npm test
  lint: npm run lint
  build: npm run build
```
