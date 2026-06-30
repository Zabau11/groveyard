import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const agentRunSummarySchema = z.object({
  agent: z.string(),
  status: z.enum(["accepted", "rejected", "failed"]),
  changedFiles: z.array(z.string()),
  violations: z.array(z.string()),
});

const runSummarySchema = z.object({
  runId: z.string(),
  baseBranch: z.string(),
  status: z.enum(["completed", "completed_with_rejections", "failed"]),
  runPath: z.string(),
  agents: z.array(agentRunSummarySchema),
});

const compositionSummarySchema = z.object({
  status: z.enum(["composed", "composed_with_skips", "failed"]),
  branch: z.string(),
  workspacePath: z.string(),
  applied: z.array(z.unknown()),
  skipped: z.array(z.unknown()),
});

const verificationSummarySchema = z.object({
  status: z.enum(["passed", "failed", "skipped"]),
  commands: z.array(z.unknown()),
});

type RunSummary = z.infer<typeof runSummarySchema>;

export type RunStatusDetail = {
  run: RunSummary;
  composition?: z.infer<typeof compositionSummarySchema>;
  verification?: z.infer<typeof verificationSummarySchema>;
  reportExists: boolean;
};

export type RunStatusListItem = {
  runId: string;
  status: string;
  agents: number;
  accepted: number;
  rejected: number;
  failed: number;
  composed: boolean;
  verified: string;
  reported: boolean;
};

export async function listRunStatuses(cwd: string): Promise<RunStatusListItem[]> {
  const runsRoot = join(cwd, ".agentx", "runs");
  if (!(await pathExists(runsRoot))) {
    return [];
  }

  const entries = await readdir(runsRoot, { withFileTypes: true });
  const items: RunStatusListItem[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const detail = await readRunStatus(entry.name, cwd);
    if (!detail) {
      continue;
    }

    items.push(toListItem(detail));
  }

  return items.sort((left, right) => left.runId.localeCompare(right.runId));
}

export async function getRunStatus(runId: string, cwd: string): Promise<RunStatusDetail> {
  const detail = await readRunStatus(runId, cwd);
  if (!detail) {
    throw new Error(`Run summary not found: .agentx/runs/${runId}/summary.json`);
  }

  return detail;
}

function toListItem(detail: RunStatusDetail): RunStatusListItem {
  const accepted = detail.run.agents.filter((agent) => agent.status === "accepted").length;
  const rejected = detail.run.agents.filter((agent) => agent.status === "rejected").length;
  const failed = detail.run.agents.filter((agent) => agent.status === "failed").length;

  return {
    runId: detail.run.runId,
    status: detail.run.status,
    agents: detail.run.agents.length,
    accepted,
    rejected,
    failed,
    composed: Boolean(detail.composition),
    verified: detail.verification?.status ?? "not_run",
    reported: detail.reportExists,
  };
}

async function readRunStatus(runId: string, cwd: string): Promise<RunStatusDetail | undefined> {
  const runRoot = join(cwd, ".agentx", "runs", runId);
  const summaryPath = join(runRoot, "summary.json");
  if (!(await pathExists(summaryPath))) {
    return undefined;
  }

  const run = runSummarySchema.parse(JSON.parse(await readFile(summaryPath, "utf8")));
  const composition = await readOptionalJson(join(runRoot, "composition.json"), compositionSummarySchema);
  const verification = await readOptionalJson(join(runRoot, "verification.json"), verificationSummarySchema);
  const reportExists = await pathExists(join(runRoot, "report.md"));

  return {
    run,
    composition,
    verification,
    reportExists,
  };
}

async function readOptionalJson<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  if (!(await pathExists(path))) {
    return undefined;
  }

  return schema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
