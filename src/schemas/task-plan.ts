import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

export const agentPlanSchema = z.object({
  adapter: nonEmptyString.default("generic"),
  command: nonEmptyString.optional(),
  task: nonEmptyString,
  owns: z.array(nonEmptyString).min(1),
  mayRead: z.array(nonEmptyString).default([]),
  forbidden: z.array(nonEmptyString).default([]),
  outputs: z.array(nonEmptyString).default([]),
});

export const taskPlanSchema = z.object({
  version: z.literal(1),
  runId: nonEmptyString.regex(/^[a-zA-Z0-9._-]+$/, "runId may only contain letters, numbers, dots, underscores, and dashes"),
  baseBranch: nonEmptyString.default("main"),
  verify: z.array(nonEmptyString).default([]),
  protected: z.array(nonEmptyString).default([]),
  agents: z.record(nonEmptyString, agentPlanSchema).refine((agents) => Object.keys(agents).length > 0, {
    message: "At least one agent is required",
  }),
});

export type AgentPlan = z.infer<typeof agentPlanSchema>;
export type TaskPlan = z.infer<typeof taskPlanSchema>;
