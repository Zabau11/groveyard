# Install and use Groveyard

Groveyard gives coding-agent tasks isolated, validated Git workspaces without requiring users or agents to manage Git worktrees directly.

## One-command setup

From the repository where the coding agent runs:

```bash
npx -y @groveyard/mcp setup
```

For a one-time latest run without installing globally:

```bash
npx -y @groveyard/mcp@latest setup
```

Setup performs one idempotent flow:

1. Resolves the repository and validates existing `.groveyard.yml` before writing.
2. Creates or repairs the repository configuration, agent contract, and `.gitignore` coverage.
3. Checks Git worktree support, path safety, write access, session storage, and an MCP handshake.
4. Detects the coding app that launched setup, or chooses one primary installed app.
5. Safely merges one repo-specific Groveyard server into that app's personal configuration.
6. Installs the app's native repository instruction block and verifies persisted state.

Normal setup does not ask questions. Restart the configured app after it succeeds.

## Client selection

Groveyard supports `codex`, `claude-code`, `vscode`, `cursor`, `gemini`, `opencode`, `claude-desktop`, and `generic`.

By default setup selects the current app from runtime environment markers. If that is unavailable, it selects the only detected client or a sensible primary client. Other detected apps are shown but left untouched.

```bash
groveyard setup --list-clients
groveyard setup --client vscode
groveyard setup --client codex --client claude-code
groveyard setup --all
```

For an unknown JSON-based MCP client:

```bash
groveyard setup --client generic --config /path/to/mcp.json
```

The generic adapter preserves unrelated keys, uses an existing `servers` or `mcpServers` object, and defaults to `mcpServers` for new files.

## Automation and repair

```bash
groveyard setup --yes
groveyard setup --json --yes
groveyard setup --force
groveyard setup --no-instructions
groveyard --version
groveyard upgrade --check
groveyard upgrade
```

- `--yes` documents explicit non-interactive approval; normal setup is already question-free.
- `--json` emits exactly one report document and still performs setup.
- `--force` regenerates `.groveyard.yml` from detected package scripts while continuing other repairs.
- Existing valid `.groveyard.yml` content is preserved byte-for-byte without `--force`.
- `--no-instructions` skips native client instruction blocks.

## Safe configuration changes

Every client adapter implements detection, inspection, installation, verification, uninstall, and manual rendering through the same registry.

Before changing an existing client file, Groveyard:

- parses the configuration;
- leaves malformed files untouched and prints manual instructions;
- creates a sibling `.groveyard-backup`;
- changes only the selected repo-specific server key;
- preserves unrelated servers and settings;
- writes atomically;
- verifies the resulting command, arguments, repository path, and agent-contract path.

Generated server entries contain `GROVEYARD_MANAGED_VERSION=1` as their ownership/version marker. Repeated setup produces no duplicate server entries or instruction blocks.

## Native agent instructions

Setup installs one managed policy from a canonical source:

```markdown
## Groveyard workspace policy

Before modifying files, start a Groveyard session for the task.
Work only in the workspace returned by Groveyard.
Validate the session before declaring the task complete.
Do not remove a dirty workspace without explicit user approval.
```

The block is delimited by `<!-- groveyard:start -->` and `<!-- groveyard:end -->`, so Groveyard can update it without replacing user-authored content.

| Client | Repository instruction file |
| --- | --- |
| Codex | `AGENTS.md` |
| Claude Code | `CLAUDE.md` |
| VS Code/Copilot | `.github/copilot-instructions.md` |
| Cursor | `.cursor/rules/groveyard.mdc` |
| Gemini CLI | `GEMINI.md` |
| OpenCode and generic clients | `AGENTS.md` |

The full MCP-native contract remains in `.groveyard/AGENTS.md`, the `groveyard://instructions` resource, and the `groveyard_session_workflow` prompt.

## Session lifecycle

Agents should begin code-changing work with:

```text
start_session({ taskName, workspacePath })
```

If `workspacePath` is the primary checkout, Groveyard creates a managed worktree. If it is a registered linked worktree, Groveyard adopts it and records its current branch and HEAD without requiring a clean workspace.

Primary tools:

```text
start_session
session_status
validate_session
finish_session
cleanup_session
```

Managed sessions may be removed after explicit cleanup or proven merge. Adopted sessions are released from the registry while their checkout, branch, files, and processes remain untouched. `create_session` remains available as a managed-worktree compatibility alias.

## Doctor and troubleshooting

Run:

```bash
groveyard doctor
```

Doctor checks repository validity, branch state, configuration parsing, workspace-root safety, Git worktree support, agent contracts, `.gitignore`, session-store access, MCP handshake, client configuration, native instructions, and stale/orphaned session state. Failed checks include a repair action and return a nonzero exit.

Advanced compatibility commands remain available:

```bash
groveyard init
groveyard connect claude-code
groveyard dashboard
groveyard sessions
groveyard inspect <sessionId>
groveyard clean <sessionId>
```

The MCP server and the repository must see the same filesystem. In SSH, WSL, containers, Codespaces, and other remote environments, run setup inside the environment where the coding app's agent process runs.
