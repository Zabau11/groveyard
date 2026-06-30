import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ZodError } from "zod";
import { taskPlanSchema, type TaskPlan } from "../schemas/task-plan.js";
import { globsMayOverlap } from "../validation/globs.js";

export type PlanValidationResult = {
  plan: TaskPlan;
  warnings: string[];
};

export async function validatePlanFile(planPath: string, cwd: string): Promise<PlanValidationResult> {
  const absolutePath = resolve(cwd, planPath);
  const rawPlan = await readFile(absolutePath, "utf8");
  let parsedPlan: unknown;

  try {
    parsedPlan = parseYaml(rawPlan);
  } catch (error) {
    throw new Error(`Invalid YAML in ${planPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const plan = taskPlanSchema.parse(parsedPlan);
    const ownershipResult = validateOwnership(plan);

    if (ownershipResult.errors.length > 0) {
      const details = ownershipResult.errors.map((issue) => `  - ${issue}`).join("\n");
      throw new Error(`Invalid task plan ${planPath}:\n${details}`);
    }

    return { plan, warnings: ownershipResult.warnings };
  } catch (error) {
    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => `  - ${issue.path.join(".") || "plan"}: ${issue.message}`).join("\n");
      throw new Error(`Invalid task plan ${planPath}:\n${details}`);
    }

    throw error;
  }
}

function validateOwnership(plan: TaskPlan): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const agentEntries = Object.entries(plan.agents);

  for (const [agentName, agent] of agentEntries) {
    for (const ownedGlob of agent.owns) {
      for (const protectedGlob of plan.protected) {
        if (globsMayOverlap(ownedGlob, protectedGlob)) {
          errors.push(`Agent "${agentName}" owns "${ownedGlob}", which may overlap protected path "${protectedGlob}".`);
        }
      }

      for (const forbiddenGlob of agent.forbidden) {
        if (globsMayOverlap(ownedGlob, forbiddenGlob)) {
          errors.push(`Agent "${agentName}" owns "${ownedGlob}", which may overlap its forbidden path "${forbiddenGlob}".`);
        }
      }
    }
  }

  for (let leftIndex = 0; leftIndex < agentEntries.length; leftIndex += 1) {
    const [leftName, leftAgent] = agentEntries[leftIndex]!;

    for (let rightIndex = leftIndex + 1; rightIndex < agentEntries.length; rightIndex += 1) {
      const [rightName, rightAgent] = agentEntries[rightIndex]!;

      for (const leftOwnedGlob of leftAgent.owns) {
        for (const rightOwnedGlob of rightAgent.owns) {
          if (globsMayOverlap(leftOwnedGlob, rightOwnedGlob)) {
            errors.push(`Agents "${leftName}" and "${rightName}" may have overlapping ownership: "${leftOwnedGlob}" and "${rightOwnedGlob}".`);
          }
        }
      }
    }
  }

  return { errors, warnings };
}
