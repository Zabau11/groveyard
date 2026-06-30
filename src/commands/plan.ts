import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { analyzeRepository, type ModuleCandidate, type RepoAnalysis } from "./analyze.js";
import { validatePlanFile } from "./validate-plan.js";
import type { TaskPlan } from "../schemas/task-plan.js";

type CreatePlanOptions = {
  adapter?: string;
  out?: string;
};

type CreatePlanResult = {
  runId: string;
  path: string;
  agentCount: number;
  rationale: string[];
};

export async function createDraftPlan(goal: string, cwd: string, options: CreatePlanOptions = {}): Promise<CreatePlanResult> {
  const analysis = await loadOrCreateAnalysis(cwd);
  const selectedModules = selectModules(goal, analysis.modules);
  if (selectedModules.length === 0) {
    throw new Error("No safe module boundaries found. Run agentx analyze and create a task plan manually.");
  }

  const runId = createRunId(goal);
  const adapter = options.adapter ?? "auto";
  const protectedPaths = unique([...analysis.protected, ...analysis.sharedFiles]);
  const agents = Object.fromEntries(
    selectedModules.map((module) => {
      const agentName = sanitizeAgentName(module.name);
      const agent = {
        adapter: "generic",
        task: `${goal}\n\nFocus only on ${module.path}. Emit agent-output/manifest.json when complete.`,
        owns: [`${module.path}/**`],
        mayRead: ["README.md", "IDEA.md", "contracts/**", "src/core/**"],
        outputs: [],
        forbidden: unique([...protectedPaths, ...selectedModules.filter((candidate) => candidate.path !== module.path).map((candidate) => `${candidate.path}/**`)]),
      };

      if (adapter === "generic") {
        return [
          agentName,
          {
            ...agent,
            adapter,
            command: `mkdir -p agent-output && printf '{"version":1,"agent":"${agentName}","summary":"Draft placeholder output for ${sanitizeJsonString(module.name)}."}\\n' > agent-output/manifest.json`,
          },
        ];
      }

      return [
        agentName,
        {
          ...agent,
          adapter,
        },
      ];
    }),
  );

  const plan: TaskPlan = {
    version: 1,
    runId,
    baseBranch: "main",
    verify: analysis.verify,
    protected: protectedPaths,
    agents,
  };

  const outputPath = options.out ?? join(".agentx", "task-plan.yml");
  const fullOutputPath = join(cwd, outputPath);
  await mkdir(join(cwd, ".agentx"), { recursive: true });
  await writeFile(fullOutputPath, stringifyYaml(plan));

  await validatePlanFile(outputPath, cwd);

  return {
    runId,
    path: fullOutputPath,
    agentCount: selectedModules.length,
    rationale: buildRationale(goal, selectedModules, analysis, adapter),
  };
}

async function loadOrCreateAnalysis(cwd: string): Promise<RepoAnalysis> {
  return analyzeRepository(cwd);
}

function selectModules(goal: string, modules: ModuleCandidate[]): ModuleCandidate[] {
  if (modules.length <= 1) {
    return modules;
  }

  const tokens = tokenize(goal);
  const directMatches = modules.filter((module) => tokens.has(module.name.toLowerCase()) || tokens.has(module.path.toLowerCase()));
  if (directMatches.length > 0) {
    return directMatches;
  }

  return modules.slice(0, 3);
}

function buildRationale(goal: string, modules: ModuleCandidate[], analysis: RepoAnalysis, adapter: string): string[] {
  const rationale = [`Generated a conservative draft plan for: ${goal}`];
  rationale.push(`Using adapter: ${adapter}.`);
  rationale.push(`Selected ${modules.length} module lane${modules.length === 1 ? "" : "s"}: ${modules.map((module) => module.path).join(", ")}.`);
  if (analysis.sharedFiles.length > 0) {
    rationale.push("Protected detected shared files so normal agents cannot edit them directly.");
  }
  if (analysis.verify.length > 0) {
    rationale.push("Copied detected verification commands from repository analysis.");
  }

  return rationale;
}

function createRunId(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const suffix = new Date().toISOString().replaceAll(/[-:]/g, "").slice(0, 15);

  return `${slug || "agentx-run"}-${suffix}`;
}

function sanitizeAgentName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "agent"
  );
}

function sanitizeJsonString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9/._-]+/)
      .filter(Boolean),
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
