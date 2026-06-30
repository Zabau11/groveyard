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
  const forbidden = [...plan.protected, ...agent.forbidden];

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
  return `# AgentX Task: ${agentName}

## Task

${agent.task}

## Owned Paths

${agent.owns.map((glob) => `- ${glob}`).join("\n")}

## May Read

${agent.mayRead.length > 0 ? agent.mayRead.map((glob) => `- ${glob}`).join("\n") : "- Repository files needed to complete the task"}

## Forbidden Paths

${[...plan.protected, ...agent.forbidden].map((glob) => `- ${glob}`).join("\n")}

## Output Expectations

- Make changes only inside owned paths.
- Do not edit protected or forbidden paths.
- Put optional notes in agent-output/notes.md.
- Put the required manifest in agent-output/manifest.json when implementation is complete.
`;
}

function matchesAny(filePath: string, globs: string[]): boolean {
  return globs.some((glob) => matchesGlob(filePath, glob));
}

function matchesGlob(filePath: string, glob: string): boolean {
  return minimatch(filePath, glob, { dot: true });
}
