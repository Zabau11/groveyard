import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { generateRoutesFile, type GeneratedFile } from "../generators/routes.js";
import { taskPlanSchema } from "../schemas/task-plan.js";

const agentRunSummarySchema = z.object({
  agent: z.string(),
  status: z.enum(["accepted", "rejected", "failed"]),
  patchPath: z.string(),
  changedFiles: z.array(z.string()),
  violations: z.array(z.string()),
  manifestPath: z.string().optional(),
});

const runSummarySchema = z.object({
  runId: z.string(),
  baseBranch: z.string(),
  status: z.enum(["completed", "completed_with_rejections", "failed"]),
  runPath: z.string(),
  agents: z.array(agentRunSummarySchema),
});

type AgentRunSummary = z.infer<typeof agentRunSummarySchema>;
type RunSummary = z.infer<typeof runSummarySchema>;

type AppliedPatch = {
  agent: string;
  patchPath: string;
  changedFiles: string[];
};

type SkippedPatch = {
  agent: string;
  status: AgentRunSummary["status"];
  reason: string;
};

type CompositionSummary = {
  runId: string;
  status: "composed" | "composed_with_skips" | "failed";
  branch: string;
  workspacePath: string;
  applied: AppliedPatch[];
  skipped: SkippedPatch[];
  generatedFiles: GeneratedFile[];
};

export async function composeRun(runId: string, cwd: string): Promise<CompositionSummary> {
  const runRoot = join(cwd, ".agentx", "runs", runId);
  const summaryPath = join(runRoot, "summary.json");

  if (!(await pathExists(summaryPath))) {
    throw new Error(`Run summary not found: .agentx/runs/${runId}/summary.json`);
  }

  const runSummary = runSummarySchema.parse(JSON.parse(await readFile(summaryPath, "utf8")));
  const taskPlan = taskPlanSchema.parse(parseYaml(await readFile(join(runRoot, "task-plan.yml"), "utf8")));
  const branch = `agentx/${runSummary.runId}`;
  const workspacePath = join(cwd, ".agentx", "worktrees", runSummary.runId, "integration");

  if (await pathExists(workspacePath)) {
    throw new Error(`Integration worktree already exists: .agentx/worktrees/${runSummary.runId}/integration`);
  }

  await ensureGitRepository(cwd);
  await mkdir(join(cwd, ".agentx", "worktrees", runSummary.runId), { recursive: true });
  await createIntegrationWorktree(cwd, workspacePath, branch, runSummary.baseBranch);

  const applied: AppliedPatch[] = [];
  const skipped: SkippedPatch[] = [];

  for (const agent of runSummary.agents) {
    if (agent.status !== "accepted") {
      skipped.push({
        agent: agent.agent,
        status: agent.status,
        reason: agent.violations.length > 0 ? agent.violations.join("; ") : `Agent status is ${agent.status}.`,
      });
      continue;
    }

    if (agent.changedFiles.length === 0) {
      skipped.push({
        agent: agent.agent,
        status: agent.status,
        reason: "No changed files to compose.",
      });
      continue;
    }

    const patch = await readFile(agent.patchPath, "utf8");
    if (patch.trim().length === 0) {
      skipped.push({
        agent: agent.agent,
        status: agent.status,
        reason: "Patch is empty.",
      });
      continue;
    }

    await applyPatch(workspacePath, agent.patchPath);
    applied.push({
      agent: agent.agent,
      patchPath: agent.patchPath,
      changedFiles: agent.changedFiles,
    });
  }

  const generatedFiles = await runGenerators(workspacePath, runSummary.agents, taskPlan.generators.routes?.output);
  const status = (applied.length > 0 || generatedFiles.length > 0) && skipped.length === 0 ? "composed" : applied.length > 0 || generatedFiles.length > 0 ? "composed_with_skips" : "composed_with_skips";
  const composition: CompositionSummary = {
    runId: runSummary.runId,
    status,
    branch,
    workspacePath,
    applied,
    skipped,
    generatedFiles,
  };

  await writeFile(join(runRoot, "composition.json"), `${JSON.stringify(composition, null, 2)}\n`);

  return composition;
}

async function runGenerators(workspacePath: string, agents: AgentRunSummary[], routesOutput?: string): Promise<GeneratedFile[]> {
  const acceptedAgents = agents.filter((agent) => agent.status === "accepted");
  const generatedFiles: GeneratedFile[] = [];
  const routes = await generateRoutesFile(workspacePath, acceptedAgents, routesOutput);
  if (routes) {
    generatedFiles.push(routes);
  }

  if (generatedFiles.length > 0) {
    await execa("git", ["add", ...generatedFiles.map((file) => file.path)], { cwd: workspacePath });
  }

  return generatedFiles;
}

async function ensureGitRepository(cwd: string): Promise<void> {
  const result = await execa("git", ["rev-parse", "--is-inside-work-tree"], { cwd, reject: false });
  if (result.exitCode !== 0 || result.stdout.trim() !== "true") {
    throw new Error("agentx compose must be executed inside a Git repository.");
  }
}

async function createIntegrationWorktree(cwd: string, workspacePath: string, branch: string, baseBranch: string): Promise<void> {
  const branchExists = await gitRefExists(cwd, branch);
  const args = branchExists
    ? ["worktree", "add", workspacePath, branch]
    : ["worktree", "add", "-b", branch, workspacePath, baseBranch];
  const result = await execa("git", args, { cwd, reject: false, all: true });

  if (result.exitCode !== 0) {
    throw new Error(`Failed to create integration worktree ${workspacePath}:\n${result.all ?? ""}`);
  }
}

async function gitRefExists(cwd: string, ref: string): Promise<boolean> {
  const result = await execa("git", ["show-ref", "--verify", "--quiet", `refs/heads/${ref}`], { cwd, reject: false });
  return result.exitCode === 0;
}

async function applyPatch(workspacePath: string, patchPath: string): Promise<void> {
  const check = await execa("git", ["apply", "--check", patchPath], { cwd: workspacePath, reject: false, all: true });
  if (check.exitCode !== 0) {
    throw new Error(`Patch failed validation before apply: ${patchPath}\n${check.all ?? ""}`);
  }

  const apply = await execa("git", ["apply", "--index", patchPath], { cwd: workspacePath, reject: false, all: true });
  if (apply.exitCode !== 0) {
    throw new Error(`Patch failed to apply: ${patchPath}\n${apply.all ?? ""}`);
  }
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
