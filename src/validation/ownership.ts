import { minimatch } from "minimatch";
import type { AgentPlan, TaskPlan } from "../schemas/task-plan.js";

export type ChangedFileValidation = {
  accepted: boolean;
  violations: string[];
};

export function validateChangedFiles(plan: TaskPlan, agentName: string, changedFiles: string[]): ChangedFileValidation {
  const agent = plan.agents[agentName];
  if (!agent) {
    throw new Error(`Unknown agent "${agentName}"`);
  }

  const violations: string[] = [];
  const forbidden = unique([...plan.protected, ...agent.forbidden]);

  for (const filePath of changedFiles) {
    if (!matchesAny(filePath, agent.owns)) {
      violations.push(`${filePath} is outside owned paths: ${agent.owns.join(", ")}`);
      continue;
    }

    const matchingForbidden = forbidden.find((glob) => matchesGlob(filePath, glob));
    if (matchingForbidden) {
      violations.push(`${filePath} matches forbidden path: ${matchingForbidden}`);
    }
  }

  return {
    accepted: violations.length === 0,
    violations,
  };
}

export function renderAgentTask(agentName: string, agent: AgentPlan, plan: TaskPlan): string {
  const forbidden = [...plan.protected, ...agent.forbidden];
  const manifestExample = JSON.stringify(
    {
      version: 1,
      agent: agentName,
      feature: agentName,
      summary: "Short summary of what changed.",
      exports: [
        {
          id: `${agentName}.export.ExampleSymbol`,
          symbol: "ExampleSymbol",
          from: "src/path/to/file",
        },
      ],
      routes: [
        {
          id: `${agentName}.route.example`,
          path: "/example",
          component: "ExamplePage",
          priority: 50,
        },
      ],
      navigation: [
        {
          id: `${agentName}.nav.example`,
          label: "Example",
          path: "/example",
          permission: `${agentName}:read`,
        },
      ],
      permissions: [
        {
          id: `${agentName}.permission.read`,
          name: `${agentName}:read`,
        },
      ],
      contractChangeRequests: [],
      dependencyRequests: [],
    },
    null,
    2,
  );
  const blockedManifestExample = JSON.stringify(
    {
      version: 1,
      agent: agentName,
      feature: agentName,
      summary: "Blocked because the task requires a protected contract change.",
      exports: [],
      routes: [],
      navigation: [],
      permissions: [],
      contractChangeRequests: [
        {
          contract: "NameOfContract",
          requestedChange: "Describe the needed contract change.",
          reason: "Explain why the task cannot be completed safely without it.",
          impact: [agentName],
        },
      ],
      dependencyRequests: [],
    },
    null,
    2,
  );

  return `# AgentX Task: ${agentName}

You are running inside an isolated AgentX worktree. Your output will be accepted only if it stays inside the ownership rules below and includes a valid manifest.

## Task

${agent.task}

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

${agent.owns.map((glob) => `- ${glob}`).join("\n")}

## May Read

${agent.mayRead.length > 0 ? agent.mayRead.map((glob) => `- ${glob}`).join("\n") : "- Repository files needed to complete the task"}

## Forbidden Paths

${forbidden.map((glob) => `- ${glob}`).join("\n")}

## Manifest Contract

Create this file:

\`\`\`text
agent-output/manifest.json
\`\`\`

The manifest must be valid JSON. The top-level \`agent\` value must be exactly:

\`\`\`text
${agentName}
\`\`\`

Use empty arrays for contribution types that do not apply. IDs must be globally unique and should be prefixed with \`${agentName}.\`.

Template:

\`\`\`json
${manifestExample}
\`\`\`

If you are blocked by a protected file, shared contract, or dependency need, still create a manifest and describe the request instead of editing forbidden files:

\`\`\`json
${blockedManifestExample}
\`\`\`

## Completion Checklist

- All source changes are inside owned paths.
- No forbidden/protected files were changed.
- agent-output/manifest.json exists and is valid JSON.
- manifest.agent is exactly "${agentName}".
- Manifest IDs are unique and prefixed with "${agentName}." where possible.
- agent-output/notes.md exists if there are important caveats for the reviewer.

## Review Context

AgentX will validate changed files, validate the manifest schema, reject duplicate manifest IDs, compose accepted patches, run verification commands, and produce a report.
`;
}

function matchesAny(filePath: string, globs: string[]): boolean {
  return globs.some((glob) => matchesGlob(filePath, glob));
}

function matchesGlob(filePath: string, glob: string): boolean {
  return minimatch(filePath, glob, { dot: true });
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
