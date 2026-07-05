import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { resolveAgentCommandDetails } from "./adapters.js";
import { createAgentOutputParser } from "./output-parsers.js";
import { validatePlanFile } from "./validate-plan.js";
import { renderAgentTask, validateChangedFiles } from "../validation/ownership.js";
import type { TaskPlan } from "../schemas/task-plan.js";
import { findDuplicateManifestIds, validateManifestFile } from "../validation/manifests.js";
import type { AgentManifest } from "../schemas/agent-manifest.js";

type AgentRunStatus = "accepted" | "rejected" | "failed";

type AgentRunSummary = {
  agent: string;
  status: AgentRunStatus;
  command: string;
  exitCode: number;
  workspacePath: string;
  changedFiles: string[];
  violations: string[];
  manifestValidation: {
    valid: boolean;
    errors: string[];
  };
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

export type RunProgressEvent =
  | { type: "run_started"; runId: string; agentCount: number; worktreeRoot: string }
  | { type: "agent_started"; agent: string; index: number; total: number; workspacePath: string; owns: string[] }
  | { type: "agent_command"; agent: string; command: string }
  | { type: "agent_activity"; agent: string; activity: string }
  | { type: "agent_output"; agent: string; chunk: string }
  | { type: "agent_finished"; agent: string; status: AgentRunStatus; exitCode: number; changedFiles: number; violations: number; logPath: string }
  | { type: "run_finished"; runId: string; status: RunSummary["status"]; summaryPath: string };

type RunPlanOptions = {
  onProgress?: (event: RunProgressEvent) => void;
};

export async function runPlanFile(planPath: string, cwd: string, options: RunPlanOptions = {}): Promise<RunSummary> {
  const { plan } = await validatePlanFile(planPath, cwd);
  const runRoot = join(cwd, ".paraflow", "runs", plan.runId);
  const worktreeRoot = join(cwd, ".paraflow", "worktrees", plan.runId);

  if (await pathExists(runRoot)) {
    throw new Error(`Run already exists: .paraflow/runs/${plan.runId}`);
  }

  await ensureGitRepository(cwd);
  await mkdir(join(runRoot, "agents"), { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await copyFile(resolve(cwd, planPath), join(runRoot, "task-plan.yml"));

  const agents: AgentRunSummary[] = [];
  const agentEntries = Object.entries(plan.agents);
  options.onProgress?.({ type: "run_started", runId: plan.runId, agentCount: agentEntries.length, worktreeRoot });

  for (const [index, agentName] of agentEntries.map(([name]) => name).entries()) {
    agents.push(await runAgent(plan, agentName, cwd, runRoot, worktreeRoot, index + 1, agentEntries.length, options));
  }

  await applyDuplicateManifestIdRejections(agents, runRoot);

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

  const summaryPath = join(runRoot, "summary.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  options.onProgress?.({ type: "run_finished", runId: plan.runId, status, summaryPath });

  return summary;
}

async function runAgent(
  plan: TaskPlan,
  agentName: string,
  cwd: string,
  runRoot: string,
  worktreeRoot: string,
  index: number,
  total: number,
  options: RunPlanOptions,
): Promise<AgentRunSummary> {
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
  options.onProgress?.({ type: "agent_started", agent: agentName, index, total, workspacePath, owns: agent.owns });
  const taskFile = ".paraflow-task.md";
  await writeFile(join(workspacePath, taskFile), renderAgentTask(agentName, agent, plan));
  const resolvedCommand = await resolveAgentCommandDetails(cwd, {
    agentName,
    agent,
    taskFile,
  });
  const command = resolvedCommand.command;
  options.onProgress?.({ type: "agent_command", agent: agentName, command });

  const startedAt = new Date().toISOString();
  const outputChunks: string[] = [];
  const outputParser = createAgentOutputParser({
    adapterName: resolvedCommand.adapterName,
    command,
    onActivity: (activity) => {
      options.onProgress?.({ type: "agent_activity", agent: agentName, activity });
    },
  });
  const subprocess = execa(command, {
    cwd: workspacePath,
    shell: true,
    reject: false,
    all: true,
    stdin: "ignore",
  });
  subprocess.all?.on("data", (chunk: Buffer | string) => {
    const text = chunk.toString();
    outputChunks.push(text);
    outputParser.push(text);
    options.onProgress?.({ type: "agent_output", agent: agentName, chunk: text });
  });
  const commandResult = await subprocess;
  outputParser.flush();
  const finishedAt = new Date().toISOString();
  const exitCode = commandResult.exitCode ?? 1;

  await writeFile(
    logPath,
    [
      `Agent: ${agentName}`,
      `Adapter: ${agent.adapter}`,
      `Resolved adapter: ${resolvedCommand.adapterName}`,
      `Command: ${command}`,
      `Started: ${startedAt}`,
      `Finished: ${finishedAt}`,
      `Exit code: ${exitCode}`,
      "",
      outputChunks.join(""),
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

  const manifestValidation = hasManifest
    ? await validateManifestFile(manifestPath, agentName)
    : {
        valid: false,
        errors: ["Missing required agent-output/manifest.json."],
      };

  const ownership = validateChangedFiles(plan, agentName, changedFiles);
  const violations = [...ownership.violations, ...manifestValidation.errors];
  let status: AgentRunStatus = ownership.accepted && manifestValidation.valid ? "accepted" : "rejected";
  if (exitCode !== 0) {
    status = "failed";
  }

  const summary: AgentRunSummary = {
    agent: agentName,
    status,
    command,
    exitCode,
    workspacePath,
    changedFiles,
    violations,
    manifestValidation: {
      valid: manifestValidation.valid,
      errors: manifestValidation.errors,
    },
    logPath,
    patchPath,
    manifestPath: hasManifest ? manifestPath : undefined,
  };

  await writeFile(join(agentRunRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  options.onProgress?.({
    type: "agent_finished",
    agent: agentName,
    status,
    exitCode,
    changedFiles: changedFiles.length,
    violations: violations.length,
    logPath,
  });

  return summary;
}

async function applyDuplicateManifestIdRejections(agents: AgentRunSummary[], runRoot: string): Promise<void> {
  const acceptedManifests = new Map<string, AgentManifest>();

  for (const agent of agents) {
    if (agent.status !== "accepted" || !agent.manifestPath) {
      continue;
    }

    const validation = await validateManifestFile(agent.manifestPath, agent.agent);
    if (validation.valid && validation.manifest) {
      acceptedManifests.set(agent.agent, validation.manifest);
    }
  }

  const duplicates = findDuplicateManifestIds(acceptedManifests);
  if (duplicates.size === 0) {
    return;
  }

  for (const [duplicateKey, duplicateAgents] of duplicates.entries()) {
    for (const agentName of duplicateAgents) {
      const agent = agents.find((candidate) => candidate.agent === agentName);
      if (!agent) {
        continue;
      }

      agent.status = "rejected";
      agent.violations.push(`Duplicate manifest ID "${duplicateKey}" is also declared by: ${duplicateAgents.filter((name) => name !== agentName).join(", ")}.`);
      agent.manifestValidation.valid = false;
      agent.manifestValidation.errors.push(`Duplicate manifest ID "${duplicateKey}".`);
    }
  }

  for (const agent of agents) {
    await writeFile(join(runRoot, "agents", agent.agent, "summary.json"), `${JSON.stringify(agent, null, 2)}\n`);
  }
}

async function ensureGitRepository(cwd: string): Promise<void> {
  const result = await execa("git", ["rev-parse", "--is-inside-work-tree"], { cwd, reject: false });
  if (result.exitCode !== 0 || result.stdout.trim() !== "true") {
    throw new Error("paraflow run must be executed inside a Git repository.");
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
  const result = await execa("git", ["diff", "--binary", "HEAD", "--", ".", ":(exclude).paraflow-task.md", ":(exclude)agent-output/**"], { cwd: workspacePath });
  return result.stdout.length > 0 ? `${result.stdout}\n` : "";
}

function addAgentChangedFile(files: Set<string>, filePath: string): void {
  if (filePath === ".paraflow-task.md" || filePath.startsWith("agent-output/")) {
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
