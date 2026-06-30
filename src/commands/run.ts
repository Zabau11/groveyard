import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execa, type ExecaError } from "execa";
import { validatePlanFile } from "./validate-plan.js";
import { renderAgentTask, validateChangedFiles } from "../validation/ownership.js";
import type { TaskPlan } from "../schemas/task-plan.js";

type AgentRunStatus = "accepted" | "rejected" | "failed";

type AgentRunSummary = {
  agent: string;
  status: AgentRunStatus;
  command: string;
  exitCode: number;
  workspacePath: string;
  changedFiles: string[];
  violations: string[];
  logPath: string;
  patchPath: string;
  manifestPath?: string;
};

type RunSummary = {
  runId: string;
  baseBranch: string;
  status: "completed" | "completed_with_rejections" | "failed";
  planPath: string;
  runPath: string;
  agents: AgentRunSummary[];
};

export async function runPlanFile(planPath: string, cwd: string): Promise<RunSummary> {
  const { plan } = await validatePlanFile(planPath, cwd);
  const runRoot = join(cwd, ".agentx", "runs", plan.runId);
  const worktreeRoot = join(cwd, ".agentx", "worktrees", plan.runId);

  if (await pathExists(runRoot)) {
    throw new Error(`Run already exists: .agentx/runs/${plan.runId}`);
  }

  await ensureGitRepository(cwd);
  await mkdir(join(runRoot, "agents"), { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await copyFile(resolve(cwd, planPath), join(runRoot, "task-plan.yml"));

  const agents: AgentRunSummary[] = [];

  for (const [agentName] of Object.entries(plan.agents)) {
    agents.push(await runAgent(plan, agentName, cwd, runRoot, worktreeRoot));
  }

  const status = agents.some((agent) => agent.status === "failed")
    ? "failed"
    : agents.some((agent) => agent.status === "rejected")
      ? "completed_with_rejections"
      : "completed";

  const summary: RunSummary = {
    runId: plan.runId,
    baseBranch: plan.baseBranch,
    status,
    planPath,
    runPath: runRoot,
    agents,
  };

  await writeFile(join(runRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

  return summary;
}

async function runAgent(plan: TaskPlan, agentName: string, cwd: string, runRoot: string, worktreeRoot: string): Promise<AgentRunSummary> {
  const agent = plan.agents[agentName];
  if (!agent) {
    throw new Error(`Unknown agent "${agentName}"`);
  }

  const agentRunRoot = join(runRoot, "agents", agentName);
  const workspacePath = join(worktreeRoot, agentName);
  const logPath = join(agentRunRoot, "log.txt");
  const patchPath = join(agentRunRoot, "patch.diff");
  const manifestPath = join(agentRunRoot, "manifest.json");

  await mkdir(agentRunRoot, { recursive: true });
  await createWorktree(cwd, workspacePath, plan.baseBranch);
  await writeFile(join(workspacePath, ".agentx-task.md"), renderAgentTask(agentName, agent, plan));

  const startedAt = new Date().toISOString();
  const commandResult = await execa(agent.command, {
    cwd: workspacePath,
    shell: true,
    reject: false,
    all: true,
  });
  const finishedAt = new Date().toISOString();
  const exitCode = commandResult.exitCode ?? 1;

  await writeFile(
    logPath,
    [
      `Agent: ${agentName}`,
      `Command: ${agent.command}`,
      `Started: ${startedAt}`,
      `Finished: ${finishedAt}`,
      `Exit code: ${exitCode}`,
      "",
      commandResult.all ?? "",
    ].join("\n"),
  );

  const changedFiles = await getChangedFiles(workspacePath);
  await writeFile(join(agentRunRoot, "changed-files.txt"), changedFiles.length > 0 ? `${changedFiles.join("\n")}\n` : "");

  const patch = await exportPatch(workspacePath);
  await writeFile(patchPath, patch);

  const sourceManifestPath = join(workspacePath, "agent-output", "manifest.json");
  const hasManifest = await pathExists(sourceManifestPath);
  if (hasManifest) {
    await copyFile(sourceManifestPath, manifestPath);
  }

  const ownership = validateChangedFiles(plan, agentName, changedFiles);
  let status: AgentRunStatus = ownership.accepted ? "accepted" : "rejected";
  if (exitCode !== 0) {
    status = "failed";
  }

  const summary: AgentRunSummary = {
    agent: agentName,
    status,
    command: agent.command,
    exitCode,
    workspacePath,
    changedFiles,
    violations: ownership.violations,
    logPath,
    patchPath,
    manifestPath: hasManifest ? manifestPath : undefined,
  };

  await writeFile(join(agentRunRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

  return summary;
}

async function ensureGitRepository(cwd: string): Promise<void> {
  const result = await execa("git", ["rev-parse", "--is-inside-work-tree"], { cwd, reject: false });
  if (result.exitCode !== 0 || result.stdout.trim() !== "true") {
    throw new Error("agentx run must be executed inside a Git repository.");
  }
}

async function createWorktree(cwd: string, workspacePath: string, baseBranch: string): Promise<void> {
  const result = await execa("git", ["worktree", "add", "--detach", workspacePath, baseBranch], { cwd, reject: false, all: true });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create worktree for ${baseBranch} at ${workspacePath}:\n${result.all ?? ""}`);
  }
}

async function getChangedFiles(workspacePath: string): Promise<string[]> {
  const result = await execa("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: workspacePath });
  const files = new Set<string>();

  for (const line of result.stdout.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }

    const rawPath = line.slice(3);
    if (rawPath.includes(" -> ")) {
      const [from, to] = rawPath.split(" -> ");
      if (from) {
        addAgentChangedFile(files, stripGitQuotes(from));
      }
      if (to) {
        addAgentChangedFile(files, stripGitQuotes(to));
      }
      continue;
    }

    addAgentChangedFile(files, stripGitQuotes(rawPath));
  }

  return [...files].sort();
}

async function exportPatch(workspacePath: string): Promise<string> {
  await execa("git", ["add", "--intent-to-add", "."], { cwd: workspacePath });
  const result = await execa("git", ["diff", "--binary", "HEAD", "--", ".", ":(exclude).agentx-task.md"], { cwd: workspacePath });
  return result.stdout.length > 0 ? `${result.stdout}\n` : "";
}

function addAgentChangedFile(files: Set<string>, filePath: string): void {
  if (filePath === ".agentx-task.md") {
    return;
  }

  files.add(filePath);
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

function stripGitQuotes(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
