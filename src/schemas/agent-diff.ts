import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);
const nonNegativeInteger = z.number().int().min(0);

export const diffFileStatusSchema = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "typechange",
  "unmerged",
  "unknown",
]);

export const diffViolationRuleSchema = z.enum([
  "outside-owned-paths",
  "protected-path",
  "forbidden-path",
  "generated-path",
  "package-manager-file",
  "lockfile",
  "contract-file",
]);

export const diffFileSchema = z.object({
  path: nonEmptyString,
  previousPath: nonEmptyString.optional(),
  status: diffFileStatusSchema,
  additions: nonNegativeInteger.default(0),
  deletions: nonNegativeInteger.default(0),
  binary: z.boolean().default(false),
});

export const diffViolationSchema = z.object({
  path: nonEmptyString,
  rule: diffViolationRuleSchema,
  message: nonEmptyString,
});

export const diffSummarySchema = z.object({
  filesChanged: nonNegativeInteger.default(0),
  additions: nonNegativeInteger.default(0),
  deletions: nonNegativeInteger.default(0),
});

export const agentDiffSchema = z.object({
  version: z.literal(1),
  agent: nonEmptyString,
  baseRef: nonEmptyString.optional(),
  headRef: nonEmptyString.optional(),
  patchPath: nonEmptyString.default("agent-output/patch.diff"),
  files: z.array(diffFileSchema).default([]),
  violations: z.array(diffViolationSchema).default([]),
  summary: diffSummarySchema.optional(),
});

export type DiffFileStatus = z.infer<typeof diffFileStatusSchema>;
export type DiffViolationRule = z.infer<typeof diffViolationRuleSchema>;
export type DiffFile = z.infer<typeof diffFileSchema>;
export type DiffViolation = z.infer<typeof diffViolationSchema>;
export type DiffSummary = z.infer<typeof diffSummarySchema>;
export type AgentDiff = z.infer<typeof agentDiffSchema>;
