# Paraflow Task: guard-agent

You are running inside an isolated Paraflow worktree. Your output will be accepted only if it stays inside the ownership rules below and includes a valid manifest.

## Task

make output friendlier and add a bit of color, also simplfiy the check command

Work as one scoped coding agent. Keep the implementation inside the allowed paths and avoid opportunistic cleanup outside this task.

If the task needs a protected file, do not edit it directly. Describe the need in agent-output/manifest.json.

## Non-Negotiable Rules

- Edit only files that match the owned paths.
- Do not edit protected, forbidden, generated, package-manager, lockfile, or contract files.
- Do not run destructive Git commands such as reset, checkout, clean, rebase, or branch deletion.
- Do not install dependencies or edit package files. If a dependency is needed, declare it in the manifest.
- Do not move or rename repository structure unless the owned paths explicitly make that safe.
- Keep the implementation scoped to this task. Avoid opportunistic refactors.
- If the task cannot be completed without touching forbidden paths, do not touch them. Emit a contract-change or dependency request instead.
- Always create agent-output/manifest.json before finishing.
- Optional notes may go in agent-output/notes.md.

## Owned Paths

- src/commands/**

## May Read

- README.md
- IDEA.md
- src/index.ts
- src/schemas/**
- src/validation/**

## Forbidden Paths

- .paraflow/**
- contracts/**
- src/generated/**
- package.json
- package-lock.json
- pnpm-lock.yaml
- yarn.lock
- bun.lockb
- src/generators/routes.ts
- src/index.ts
- tsconfig.json

## Manifest Contract

Create this file:

```text
agent-output/manifest.json
```

The manifest must be valid JSON. The top-level `agent` value must be exactly:

```text
guard-agent
```

Use empty arrays for contribution types that do not apply. IDs must be globally unique and should be prefixed with `guard-agent.`.

Template:

```json
{
  "version": 1,
  "agent": "guard-agent",
  "feature": "guard-agent",
  "summary": "Short summary of what changed.",
  "exports": [
    {
      "id": "guard-agent.export.ExampleSymbol",
      "symbol": "ExampleSymbol",
      "from": "src/path/to/file"
    }
  ],
  "routes": [
    {
      "id": "guard-agent.route.example",
      "path": "/example",
      "component": "ExamplePage",
      "priority": 50
    }
  ],
  "navigation": [
    {
      "id": "guard-agent.nav.example",
      "label": "Example",
      "path": "/example",
      "permission": "guard-agent:read"
    }
  ],
  "permissions": [
    {
      "id": "guard-agent.permission.read",
      "name": "guard-agent:read"
    }
  ],
  "contractChangeRequests": [],
  "dependencyRequests": []
}
```

If you are blocked by a protected file, shared contract, or dependency need, still create a manifest and describe the request instead of editing forbidden files:

```json
{
  "version": 1,
  "agent": "guard-agent",
  "feature": "guard-agent",
  "summary": "Blocked because the task requires a protected contract change.",
  "exports": [],
  "routes": [],
  "navigation": [],
  "permissions": [],
  "contractChangeRequests": [
    {
      "contract": "NameOfContract",
      "requestedChange": "Describe the needed contract change.",
      "reason": "Explain why the task cannot be completed safely without it.",
      "impact": [
        "guard-agent"
      ]
    }
  ],
  "dependencyRequests": []
}
```

## Completion Checklist

- All source changes are inside owned paths.
- No forbidden/protected files were changed.
- agent-output/manifest.json exists and is valid JSON.
- manifest.agent is exactly "guard-agent".
- Manifest IDs are unique and prefixed with "guard-agent." where possible.
- agent-output/notes.md exists if there are important caveats for the reviewer.

## Review Context

Paraflow will validate changed files, validate the manifest schema, reject duplicate manifest IDs, compose accepted patches, run verification commands, and produce a report.
