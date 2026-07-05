# Paraflow Orchestrator

Paraflow keeps AI coding agents in their lane.

Use it with Codex, Claude Code, Cursor, Superset, or any coding agent. Paraflow creates a small task contract before the agent works, then checks whether the agent changed only what it was allowed to change.

## Quick Start

Guard one agent task:

```bash
paraflow guard "Fix the checkout button"
```

Paraflow writes the active contract to:

```text
.paraflow/current/
  task.md
  contract.yml
  plan.yml
```

Give `.paraflow/current/task.md` to your coding agent. When it finishes:

```bash
paraflow check
```

Split a larger task into safe lanes:

```bash
paraflow split "Add password reset and invoice export"
```

Paraflow writes one packet per agent:

```text
.paraflow/current/agents/<agent>/task.md
.paraflow/current/agents/<agent>/contract.yml
```

After the agents finish, check their workspaces:

```bash
paraflow check --agent auth --workspace ../auth-worktree
paraflow check --workspace-root ../agent-worktrees
```

`guard` keeps one active task. Running it again replaces `.paraflow/current`, so the default flow stays simple.

## Development

```bash
npm install
npm run dev -- --help
npm run build
```
