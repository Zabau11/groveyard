import { z } from "zod";

export const sessionStatusSchema = z.enum(["active", "completed", "cleaned", "released", "failed"]);
export const sessionOriginSchema = z.enum(["managed", "adopted"]);

export const sessionContractSchema = z.object({
  readPaths: z.array(z.string()).default([]),
  listedPaths: z.array(z.string()).default([]),
  writtenPaths: z.array(z.string()).default([]),
  commandProfilesRun: z.array(z.string()).default([]),
  lastMutationAt: z.string().datetime().optional(),
  lastStatusAt: z.string().datetime().optional(),
  lastDiffAt: z.string().datetime().optional(),
});

export const sessionRecordSchema = z.object({
  id: z.string().min(1),
  repoPath: z.string().min(1),
  worktreePath: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  baseCommit: z.string().min(1).optional(),
  taskName: z.string().min(1),
  origin: sessionOriginSchema.default("managed"),
  status: sessionStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  contract: sessionContractSchema.default({}),
});

const sessionRegistryV1Schema = z.object({
  version: z.literal(1),
  sessions: z.array(sessionRecordSchema),
});

const sessionRegistryV2Schema = z.object({
  version: z.literal(2),
  sessions: z.array(sessionRecordSchema),
});

export const sessionRegistrySchema = z.union([sessionRegistryV1Schema, sessionRegistryV2Schema]).transform((data) => ({
  version: 2 as const,
  sessions: data.sessions.map((session) => ({ ...session, origin: session.origin ?? "managed" as const })),
}));

export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type SessionOrigin = z.infer<typeof sessionOriginSchema>;
export type SessionContract = z.infer<typeof sessionContractSchema>;
export type SessionRecord = z.infer<typeof sessionRecordSchema>;
export type SessionRegistryData = z.infer<typeof sessionRegistrySchema>;

export function newSessionRegistryData(): SessionRegistryData {
  return {
    version: 2,
    sessions: [],
  };
}

export function touchSession(session: SessionRecord, now = new Date()): SessionRecord {
  return {
    ...session,
    updatedAt: now.toISOString(),
  };
}
