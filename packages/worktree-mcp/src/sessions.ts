import { z } from "zod";

export const sessionStatusSchema = z.enum(["active", "completed", "cleaned", "failed"]);

export const sessionRecordSchema = z.object({
  id: z.string().min(1),
  repoPath: z.string().min(1),
  worktreePath: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  taskName: z.string().min(1),
  status: sessionStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const sessionRegistrySchema = z.object({
  version: z.literal(1),
  sessions: z.array(sessionRecordSchema),
});

export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type SessionRecord = z.infer<typeof sessionRecordSchema>;
export type SessionRegistryData = z.infer<typeof sessionRegistrySchema>;

export function newSessionRegistryData(): SessionRegistryData {
  return {
    version: 1,
    sessions: [],
  };
}

export function touchSession(session: SessionRecord, now = new Date()): SessionRecord {
  return {
    ...session,
    updatedAt: now.toISOString(),
  };
}
