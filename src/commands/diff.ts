import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { z } from "zod";
import { selectRun } from "./select-run.js";

const agentRunSummarySchema = z.object({
  agent: z.string(),
  status: z.enum(["accepted", "rejected", "failed"]),
  patchPath: z.string(),
  changedFiles: z.array(z.string()),
  violations: z.array(z.string()).default([]),
});

const runSummarySchema = z.object({
  runId: z.string(),
  agents: z.array(agentRunSummarySchema),
});

const compositionSummarySchema = z.object({
  status: z.enum(["composed", "composed_with_skips", "failed"]),
  branch: z.string(),
  workspacePath: z.string(),
});

type AgentRunSummary = z.infer<typeof agentRunSummarySchema>;
type CompositionSummary = z.infer<typeof compositionSummarySchema>;

export type DiffOptions = {
  run?: string;
  agent?: string;
  includeRejected?: boolean;
  nameOnly?: boolean;
};

export type AgentDiff = {
  agent: string;
  status: AgentRunSummary["status"];
  patchPath: string;
  changedFiles: string[];
  diff: string;
};

export type DiffResult = {
  runId: string;
  scope: "composition" | "agent" | "agents";
  branch?: string;
  workspacePath?: string;
  files: string[];
  agents: AgentDiff[];
  diff: string;
};

export async function diffRun(cwd: string, options: DiffOptions = {}): Promise<DiffResult> {
  const runId = options.run ?? (await selectRun(cwd, { kind: "any", action: "diff" }));
  const runRoot = join(cwd, ".agentx", "runs", runId);
  const summaryPath = join(runRoot, "summary.json");

  if (!(await pathExists(summaryPath))) {
    throw new Error(`Run summary not found: .agentx/runs/${runId}/summary.json`);
  }

  const run = runSummarySchema.parse(JSON.parse(await readFile(summaryPath, "utf8")));
  if (options.agent) {
    return diffAgent(run.runId, findAgent(run.agents, options.agent), options);
  }

  const composition = await readOptionalJson(join(runRoot, "composition.json"), compositionSummarySchema);
  if (composition && composition.status !== "failed") {
    return diffComposition(run.runId, composition, options);
  }

  return diffAgents(run.runId, run.agents, options);
}

async function diffComposition(runId: string, composition: CompositionSummary, options: DiffOptions): Promise<DiffResult> {
  if (!(await pathExists(composition.workspacePath))) {
    throw new Error(`Integration workspace not found: ${composition.workspacePath}`);
  }

  const args = options.nameOnly ? ["diff", "--name-only", "HEAD"] : ["diff", "--binary", "HEAD"];
  const diff = await git(args, composition.workspacePath);
  const files = options.nameOnly ? lines(diff) : lines(await git(["diff", "--name-only", "HEAD"], composition.workspacePath));

  return {
    runId,
    scope: "composition",
    branch: composition.branch,
    workspacePath: composition.workspacePath,
    files,
    agents: [],
    diff,
  };
}

async function diffAgent(runId: string, agent: AgentRunSummary, options: DiffOptions): Promise<DiffResult> {
  const agentDiff = await readAgentDiff(agent, options);

  return {
    runId,
    scope: "agent",
    files: agentDiff.changedFiles,
    agents: [agentDiff],
    diff: agentDiff.diff,
  };
}

async function diffAgents(runId: string, agents: AgentRunSummary[], options: DiffOptions): Promise<DiffResult> {
  const eligibleAgents = agents.filter((agent) => options.includeRejected || agent.status === "accepted");
  const agentDiffs = await Promise.all(eligibleAgents.map((agent) => readAgentDiff(agent, options)));

  return {
    runId,
    scope: "agents",
    files: uniqueSorted(agentDiffs.flatMap((agent) => agent.changedFiles)),
    agents: agentDiffs,
    diff: agentDiffs.map((agent) => agent.diff).filter((diff) => diff.trim().length > 0).join("\n"),
  };
}

async function readAgentDiff(agent: AgentRunSummary, options: DiffOptions): Promise<AgentDiff> {
  if (!(await pathExists(agent.patchPath))) {
    throw new Error(`Patch not found for agent "${agent.agent}": ${agent.patchPath}`);
  }

  const diff = options.nameOnly ? `${agent.changedFiles.join("\n")}${agent.changedFiles.length > 0 ? "\n" : ""}` : await readFile(agent.patchPath, "utf8");

  return {
    agent: agent.agent,
    status: agent.status,
    patchPath: agent.patchPath,
    changedFiles: [...agent.changedFiles].sort(),
    diff,
  };
}

function findAgent(agents: AgentRunSummary[], agentName: string): AgentRunSummary {
  const agent = agents.find((candidate) => candidate.agent === agentName);
  if (!agent) {
    throw new Error(`Agent "${agentName}" was not found in this run.`);
  }

  return agent;
}

async function readOptionalJson<S extends z.ZodTypeAny>(path: string, schema: S): Promise<z.output<S> | undefined> {
  if (!(await pathExists(path))) {
    return undefined;
  }

  return schema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function git(args: string[], cwd: string): Promise<string> {
  const result = await execa("git", args, { cwd });
  return result.stdout.length > 0 ? `${result.stdout}\n` : "";
}

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
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
