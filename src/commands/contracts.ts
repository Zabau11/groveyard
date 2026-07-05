import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execa } from "execa";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { previewDraftPlan } from "./plan.js";
import type { PlannerMode } from "./planner.js";
import { taskPlanSchema, type AgentPlan, type TaskPlan } from "../schemas/task-plan.js";
import { renderAgentTask, validateChangedFiles } from "../validation/ownership.js";
import { findDuplicateManifestIds, validateManifestFile, type ManifestValidation } from "../validation/manifests.js";
import { globsMayOverlap } from "../validation/globs.js";
import type { AgentManifest } from "../schemas/agent-manifest.js";

type ContractMode = "guard" | "split";

type CreateContractOptions = {
  planner?: PlannerMode;
};

type ContractFile = {
  agent: string;
  taskPath: string;
  contractPath: string;
};

export type CreateCurrentContractResult = {
  mode: ContractMode;
  goal: string;
  agentCount: number;
  currentPath: string;
  planPath: string;
  files: ContractFile[];
  rationale: string[];
  replaced: boolean;
};

type CheckOptions = {
  agent?: string;
  workspace?: string;
  workspaceRoot?: string;
};

type CheckAgentStatus = "accepted" | "rejected";

type CheckAgentSummary = {
  agent: string;
  status: CheckAgentStatus;
  workspacePath: string;
  changedFiles: string[];
  violations: string[];
  manifestValidation: {
    valid: boolean;
    errors: string[];
  };
  manifestPath?: string;
  manifest?: AgentManifest;
};

export type CurrentCheckResult = {
  status: CheckAgentStatus;
  currentPath: string;
  reportPath: string;
  summaryPath: string;
  agents: CheckAgentSummary[];
  warnings: string[];
};

type CurrentMetadata = {
  version: 1;
  mode: ContractMode;
  goal: string;
  createdAt: string;
  rationale: string[];
};

type Baseline = {
  version: 1;
  files: string[];
};

const currentRelativePath = join(".paraflow", "current");

export async function createGuardContract(goal: string, cwd: string, options: CreateContractOptions = {}): Promise<CreateCurrentContractResult> {
  const preview = await previewDraftPlan(goal, cwd, { adapter: "manual", planner: options.planner });
  const agentName = "guard-agent";
  const plan = createSingleAgentPlan(preview.plan, agentName, goal);
  const rationale = [
    "Created one active guard because guard mode is for the next single agent task.",
    ...preview.rationale,
  ];

  return writeCurrentContract(goal, "guard", plan, rationale, cwd);
}

export async function createSplitContract(goal: string, cwd: string, options: CreateContractOptions = {}): Promise<CreateCurrentContractResult> {
  const preview = await previewDraftPlan(goal, cwd, { adapter: "manual", planner: options.planner });
  const splitDecision = shouldCollapseSplit(goal, preview.plan);
  const plan = splitDecision.collapse ? createSingleAgentPlan(preview.plan, splitDecision.agentName, goal) : preview.plan;
  const rationale = splitDecision.collapse
    ? [splitDecision.reason, ...preview.rationale]
    : ["Created one contract per safe ownership lane.", ...preview.rationale];

  return writeCurrentContract(goal, "split", plan, rationale, cwd);
}

export async function checkCurrentContract(cwd: string, options: CheckOptions = {}): Promise<CurrentCheckResult> {
  const currentPath = join(cwd, currentRelativePath);
  const planPath = join(currentPath, "plan.yml");
  if (!(await pathExists(planPath))) {
    throw new Error("No active Paraflow contract found. Run paraflow guard \"...\" or paraflow split \"...\" first.");
  }

  const plan = taskPlanSchema.parse(parseYaml(await readFile(planPath, "utf8")));
  const targets = resolveCheckTargets(plan, cwd, options);
  const baseline = await readBaseline(currentPath);
  const warnings: string[] = [];
  if (baseline.files.length > 0 && targets.some((target) => samePath(target.workspacePath, cwd))) {
    warnings.push(`Ignored ${baseline.files.length} file${baseline.files.length === 1 ? "" : "s"} that were already changed before the current contract was created.`);
  }

  const agents: CheckAgentSummary[] = [];
  for (const target of targets) {
    agents.push(await checkAgent(plan, target.agentName, target.workspacePath, cwd, baseline));
  }

  applyDuplicateManifestRejections(agents);

  const status: CheckAgentStatus = agents.some((agent) => agent.status === "rejected") ? "rejected" : "accepted";
  const summaryPath = join(currentPath, "check.json");
  const reportPath = join(currentPath, "report.md");
  const result: CurrentCheckResult = {
    status,
    currentPath,
    reportPath,
    summaryPath,
    agents,
    warnings,
  };

  await writeFile(summaryPath, `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(reportPath, renderCheckReport(result));

  return result;
}

async function writeCurrentContract(
  goal: string,
  mode: ContractMode,
  plan: TaskPlan,
  rationale: string[],
  cwd: string,
): Promise<CreateCurrentContractResult> {
  const currentPath = join(cwd, currentRelativePath);
  const replaced = await pathExists(currentPath);
  const baselineFiles = await getChangedFiles(cwd);

  await rm(currentPath, { recursive: true, force: true });
  await mkdir(join(currentPath, "agents"), { recursive: true });

  const planPath = join(currentPath, "plan.yml");
  await writeFile(planPath, stringifyYaml(plan));
  await writeJson(join(currentPath, "meta.json"), {
    version: 1,
    mode,
    goal,
    createdAt: new Date().toISOString(),
    rationale,
  } satisfies CurrentMetadata);
  await writeJson(join(currentPath, "baseline.json"), {
    version: 1,
    files: baselineFiles,
  } satisfies Baseline);

  const files: ContractFile[] = [];
  const agentEntries = Object.entries(plan.agents);
  for (const [agentName, agent] of agentEntries) {
    const agentRoot = join(currentPath, "agents", agentName);
    await mkdir(agentRoot, { recursive: true });

    const taskText = renderAgentTask(agentName, agent, plan);
    const contractText = stringifyYaml(renderAgentContract(mode, goal, plan, agentName, agent));
    const taskPath = join(agentRoot, "task.md");
    const contractPath = join(agentRoot, "contract.yml");

    await writeFile(taskPath, taskText);
    await writeFile(contractPath, contractText);

    files.push({
      agent: agentName,
      taskPath,
      contractPath,
    });
  }

  if (agentEntries.length === 1) {
    const [agentName, agent] = agentEntries[0]!;
    await writeFile(join(currentPath, "task.md"), renderAgentTask(agentName, agent, plan));
    await writeFile(join(currentPath, "contract.yml"), stringifyYaml(renderAgentContract(mode, goal, plan, agentName, agent)));
  }

  return {
    mode,
    goal,
    agentCount: files.length,
    currentPath,
    planPath,
    files,
    rationale,
    replaced,
  };
}

function createSingleAgentPlan(plan: TaskPlan, agentName: string, goal: string): TaskPlan {
  const sourceAgents = Object.values(plan.agents);
  const owns = unique(sourceAgents.flatMap((sourceAgent) => sourceAgent.owns));
  const agent: AgentPlan = {
    adapter: "manual",
    task: [
      goal,
      "",
      "Work as one scoped coding agent. Keep the implementation inside the allowed paths and avoid opportunistic cleanup outside this task.",
      "",
      "If the task needs a protected file, do not edit it directly. Describe the need in agent-output/manifest.json.",
    ].join("\n"),
    owns,
    mayRead: unique(sourceAgents.flatMap((sourceAgent) => sourceAgent.mayRead)),
    forbidden: unique(sourceAgents.flatMap((sourceAgent) => sourceAgent.forbidden)).filter((forbidden) => !owns.some((owned) => globsMayOverlap(owned, forbidden))),
    outputs: unique(sourceAgents.flatMap((sourceAgent) => sourceAgent.outputs.length > 0 ? sourceAgent.outputs : ["agent-output/manifest.json"])),
  };

  return taskPlanSchema.parse({
    ...plan,
    agents: {
      [agentName]: agent,
    },
  });
}

function shouldCollapseSplit(goal: string, plan: TaskPlan): { collapse: boolean; agentName: string; reason: string } {
  const tokens = tokenize(goal);
  if (matchesAny(tokens, ["improve", "polish", "premium", "better", "cleanup", "clean", "refine"]) && !matchesAny(tokens, agentNameTokens(plan))) {
    return {
      collapse: true,
      agentName: "discovery-agent",
      reason: "Created one task instead of splitting because the request is broad and does not map cleanly to independent ownership lanes.",
    };
  }

  const agentCount = Object.keys(plan.agents).length;
  if (agentCount <= 1) {
    return {
      collapse: false,
      agentName: "agent",
      reason: "",
    };
  }

  return {
    collapse: false,
    agentName: "agent",
    reason: "",
  };
}

function renderAgentContract(mode: ContractMode, goal: string, plan: TaskPlan, agentName: string, agent: AgentPlan): Record<string, unknown> {
  return {
    version: 1,
    mode,
    goal,
    agent: agentName,
    task: agent.task,
    edit: {
      allow: agent.owns,
      deny: unique([...plan.protected, ...agent.forbidden]),
    },
    read: {
      allow: agent.mayRead,
    },
    output: {
      required: agent.outputs.length > 0 ? agent.outputs : ["agent-output/manifest.json"],
    },
    checks: {
      beforeFinish: plan.verify,
    },
  };
}

function resolveCheckTargets(plan: TaskPlan, cwd: string, options: CheckOptions): Array<{ agentName: string; workspacePath: string }> {
  const agentNames = Object.keys(plan.agents);

  if (options.workspaceRoot) {
    const workspaceRoot = resolve(cwd, options.workspaceRoot);
    return agentNames.map((agentName) => ({
      agentName,
      workspacePath: join(workspaceRoot, agentName),
    }));
  }

  if (options.workspace) {
    const agentName = options.agent ?? onlyAgentName(agentNames, "--workspace requires --agent when the current contract has multiple agents.");
    ensureKnownAgent(agentNames, agentName);
    return [
      {
        agentName,
        workspacePath: resolve(cwd, options.workspace),
      },
    ];
  }

  if (options.agent) {
    ensureKnownAgent(agentNames, options.agent);
    return [
      {
        agentName: options.agent,
        workspacePath: cwd,
      },
    ];
  }

  if (agentNames.length === 1) {
    return [
      {
        agentName: agentNames[0]!,
        workspacePath: cwd,
      },
    ];
  }

  throw new Error(
    [
      `The current contract has ${agentNames.length} agents, so Paraflow needs to know where their workspaces are.`,
      "",
      "Run one of:",
      "  paraflow check --workspace-root <folder-with-agent-workspaces>",
      "  paraflow check --agent <name> --workspace <path>",
      "",
      `Agents: ${agentNames.join(", ")}`,
    ].join("\n"),
  );
}

async function checkAgent(plan: TaskPlan, agentName: string, workspacePath: string, cwd: string, baseline: Baseline): Promise<CheckAgentSummary> {
  if (!(await pathExists(workspacePath))) {
    return {
      agent: agentName,
      status: "rejected",
      workspacePath,
      changedFiles: [],
      violations: [`Workspace not found: ${workspacePath}`],
      manifestValidation: {
        valid: false,
        errors: [],
      },
    };
  }

  const allChangedFiles = await getChangedFiles(workspacePath);
  const baselineFiles = samePath(workspacePath, cwd) ? new Set(baseline.files) : new Set<string>();
  const changedFiles = allChangedFiles.filter((filePath) => !baselineFiles.has(filePath));
  const ownership = validateChangedFiles(plan, agentName, changedFiles);

  const manifestPath = join(workspacePath, "agent-output", "manifest.json");
  const manifestValidation = await validateManifest(manifestPath, agentName);
  const violations = [...ownership.violations, ...manifestValidation.errors];

  return {
    agent: agentName,
    status: ownership.accepted && manifestValidation.valid ? "accepted" : "rejected",
    workspacePath,
    changedFiles,
    violations,
    manifestValidation: {
      valid: manifestValidation.valid,
      errors: manifestValidation.errors,
    },
    manifestPath: manifestValidation.valid ? manifestPath : undefined,
    manifest: manifestValidation.manifest,
  };
}

async function validateManifest(manifestPath: string, agentName: string): Promise<ManifestValidation> {
  if (!(await pathExists(manifestPath))) {
    return {
      valid: false,
      errors: ["Missing required agent-output/manifest.json."],
    };
  }

  return validateManifestFile(manifestPath, agentName);
}

function applyDuplicateManifestRejections(agents: CheckAgentSummary[]): void {
  const acceptedManifests = new Map<string, AgentManifest>();
  for (const agent of agents) {
    if (agent.status !== "accepted" || !agent.manifestPath) {
      continue;
    }

    if (agent.manifest) {
      acceptedManifests.set(agent.agent, agent.manifest);
    }
  }

  const duplicates = findDuplicateManifestIds(acceptedManifests);
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
}

function renderCheckReport(result: CurrentCheckResult): string {
  const lines = [
    "# Paraflow Check Report",
    "",
    `Status: \`${result.status}\``,
    "",
    "## Agents",
    "",
    "| Agent | Status | Changed Files | Manifest |",
    "|---|---|---:|---|",
    ...result.agents.map((agent) => `| ${escapeTable(agent.agent)} | ${agent.status} | ${agent.changedFiles.length} | ${agent.manifestValidation.valid ? "valid" : "invalid"} |`),
    "",
  ];

  if (result.warnings.length > 0) {
    lines.push("## Warnings", "");
    for (const warning of result.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push("");
  }

  const violations = result.agents.flatMap((agent) => agent.violations.map((violation) => ({ agent: agent.agent, violation })));
  if (violations.length > 0) {
    lines.push("## Issues", "");
    for (const issue of violations) {
      lines.push(`- \`${issue.agent}\`: ${issue.violation}`);
    }
    lines.push("");
  }

  lines.push("## Changed Files", "");
  for (const agent of result.agents) {
    lines.push(`### ${agent.agent}`, "");
    if (agent.changedFiles.length === 0) {
      lines.push("- None");
    } else {
      for (const filePath of agent.changedFiles) {
        lines.push(`- \`${filePath}\``);
      }
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

async function getChangedFiles(workspacePath: string): Promise<string[]> {
  const result = await execa("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: workspacePath, reject: false });
  if (result.exitCode !== 0) {
    throw new Error(`Could not inspect changed files in ${workspacePath}. Paraflow check requires a Git workspace.`);
  }

  const files = new Set<string>();
  for (const line of result.stdout.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }

    const rawPath = line.slice(3);
    if (rawPath.includes(" -> ")) {
      const [from, to] = rawPath.split(" -> ");
      if (from) {
        addChangedFile(files, stripGitQuotes(from));
      }
      if (to) {
        addChangedFile(files, stripGitQuotes(to));
      }
      continue;
    }

    addChangedFile(files, stripGitQuotes(rawPath));
  }

  return [...files].sort();
}

function addChangedFile(files: Set<string>, filePath: string): void {
  if (filePath === ".paraflow-task.md" || filePath.startsWith(".paraflow/") || filePath.startsWith("agent-output/")) {
    return;
  }

  files.add(filePath);
}

async function readBaseline(currentPath: string): Promise<Baseline> {
  const baselinePath = join(currentPath, "baseline.json");
  if (!(await pathExists(baselinePath))) {
    return {
      version: 1,
      files: [],
    };
  }

  const parsed = JSON.parse(await readFile(baselinePath, "utf8")) as Partial<Baseline>;
  return {
    version: 1,
    files: Array.isArray(parsed.files) ? parsed.files.filter((file): file is string => typeof file === "string") : [],
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function onlyAgentName(agentNames: string[], errorMessage: string): string {
  if (agentNames.length !== 1) {
    throw new Error(errorMessage);
  }

  return agentNames[0]!;
}

function ensureKnownAgent(agentNames: string[], agentName: string): void {
  if (!agentNames.includes(agentName)) {
    throw new Error(`Unknown agent "${agentName}". Available agents: ${agentNames.join(", ")}`);
  }
}

function agentNameTokens(plan: TaskPlan): string[] {
  return Object.keys(plan.agents).flatMap((agentName) => agentName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9/._-]+/)
      .filter(Boolean),
  );
}

function matchesAny(tokens: Set<string>, values: string[]): boolean {
  return values.some((value) => tokens.has(value));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function stripGitQuotes(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function escapeTable(value: string): string {
  return value.replaceAll("|", "\\|");
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
