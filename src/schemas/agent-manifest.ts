import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

const exportDefinitionSchema = z.object({
  id: nonEmptyString,
  symbol: nonEmptyString,
  from: nonEmptyString,
});

const routeDefinitionSchema = z.object({
  id: nonEmptyString,
  path: nonEmptyString,
  component: nonEmptyString,
  priority: z.number().optional(),
});

const navigationDefinitionSchema = z.object({
  id: nonEmptyString,
  label: nonEmptyString,
  path: nonEmptyString,
  permission: z.string().optional(),
});

const permissionDefinitionSchema = z.object({
  id: nonEmptyString,
  name: nonEmptyString,
});

const contractChangeRequestSchema = z.object({
  contract: nonEmptyString,
  requestedChange: nonEmptyString,
  reason: nonEmptyString,
  impact: z.array(z.string()).default([]),
});

const dependencyRequestSchema = z.object({
  name: nonEmptyString,
  version: z.string().optional(),
  type: z.enum(["runtime", "development", "peer", "optional"]).optional(),
  reason: nonEmptyString,
});

export const agentManifestSchema = z.object({
  version: z.literal(1),
  agent: nonEmptyString,
  feature: z.string().optional(),
  summary: nonEmptyString,
  exports: z.array(exportDefinitionSchema).default([]),
  routes: z.array(routeDefinitionSchema).default([]),
  navigation: z.array(navigationDefinitionSchema).default([]),
  permissions: z.array(permissionDefinitionSchema).default([]),
  contractChangeRequests: z.array(contractChangeRequestSchema).default([]),
  dependencyRequests: z.array(dependencyRequestSchema).default([]),
});

export type AgentManifest = z.infer<typeof agentManifestSchema>;
