import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { analyzeRepository, type ModuleCandidate, type RepoAnalysis } from "./analyze.js";
import { inferLaneTaskForModule, selectModulesForGoal, type ModuleSelection, type PlannerMode } from "./planner.js";
import { validatePlanFile } from "./validate-plan.js";
import { taskPlanSchema, type TaskPlan } from "../schemas/task-plan.js";
import { globsMayOverlap } from "../validation/globs.js";

type CreatePlanOptions = {
  adapter?: string;
  out?: string;
  planner?: PlannerMode;
};

type CreatePlanResult = {
  runId: string;
  path: string;
  agentCount: number;
  rationale: string[];
};

type TaskProfile = {
  kind: "command" | "schema" | "validation" | "generator" | "tui" | "diff" | "docs" | "test" | "general";
  label: string;
  focus: string;
  mayRead: string[];
  preferredOutputs: string[];
  extraProtected: string[];
  verificationHint?: string;
};

export type DraftPlanPreview = {
  goal: string;
  plan: TaskPlan;
  selectedModules: ModuleCandidate[];
  analysis: RepoAnalysis;
  adapter: string;
  planner: ModuleSelection;
  rationale: string[];
};

export async function previewDraftPlan(goal: string, cwd: string, options: Pick<CreatePlanOptions, "adapter" | "planner"> = {}): Promise<DraftPlanPreview> {
  return buildDraftPlan(goal, cwd, { adapter: options.adapter, planner: options.planner, writeAnalysis: false });
}

export async function createDraftPlan(goal: string, cwd: string, options: CreatePlanOptions = {}): Promise<CreatePlanResult> {
  const draft = await buildDraftPlan(goal, cwd, { adapter: options.adapter, planner: options.planner, writeAnalysis: true });
  const outputPath = options.out ?? join(".paraflow", "task-plan.yml");
  const fullOutputPath = isAbsolute(outputPath) ? outputPath : join(cwd, outputPath);
  await mkdir(dirname(fullOutputPath), { recursive: true });
  await writeFile(fullOutputPath, stringifyYaml(draft.plan));

  await validatePlanFile(outputPath, cwd);

  return {
    runId: draft.plan.runId,
    path: fullOutputPath,
    agentCount: draft.selectedModules.length,
    rationale: draft.rationale,
  };
}

async function buildDraftPlan(goal: string, cwd: string, options: { adapter?: string; planner?: PlannerMode; writeAnalysis: boolean }): Promise<DraftPlanPreview> {
  const analysis = await analyzeRepository(cwd, { write: options.writeAnalysis });
  const planner = await selectModulesForGoal(goal, analysis, { cwd, mode: options.planner });
  const selectedModules = planner.modules;
  if (selectedModules.length === 0) {
    throw new Error("No safe module boundaries found. Run paraflow analyze and create a task plan manually.");
  }

  const runId = createRunId(goal);
  const adapter = options.adapter ?? "auto";
  const profile = inferTaskProfile(goal, selectedModules);
  const selectedOwnGlobs = selectedModules.map((module) => `${module.path}/**`);
  const protectedPaths = unique([...analysis.protected, ...analysis.sharedFiles, ...profile.extraProtected]).filter((protectedPath) => !selectedOwnGlobs.some((ownedGlob) => globsMayOverlap(ownedGlob, protectedPath)));
  const agents = Object.fromEntries(
    await Promise.all(selectedModules.map(async (module) => {
      const agentName = sanitizeAgentName(module.name);
      const owns = inferOwnedGlobs(module, profile);
      const laneTask = await inferLaneTaskForModule(goal, module, cwd);
      const forbidden = unique([...protectedPaths, ...selectedModules.filter((candidate) => candidate.path !== module.path).map((candidate) => `${candidate.path}/**`)]).filter(
        (forbiddenPath) => !owns.some((ownedGlob) => globsMayOverlap(ownedGlob, forbiddenPath)),
      );
      const agent = {
        adapter: "generic",
        task: buildAgentTask(goal, laneTask, module, profile),
        owns,
        mayRead: inferMayRead(module, profile),
        outputs: profile.preferredOutputs,
        forbidden,
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
    })),
  );

  const plan = taskPlanSchema.parse({
    version: 1,
    runId,
    baseBranch: "main",
    verify: analysis.verify,
    protected: protectedPaths,
    generators: inferGenerators(analysis),
    agents,
  });

  return {
    goal,
    plan,
    selectedModules,
    analysis,
    adapter,
    planner,
    rationale: buildRationale(goal, selectedModules, analysis, adapter, planner, profile),
  };
}

function buildRationale(goal: string, modules: ModuleCandidate[], analysis: RepoAnalysis, adapter: string, planner: ModuleSelection, profile: TaskProfile): string[] {
  const rationale = [`Generated a conservative draft plan for: ${goal}`];
  rationale.push(`Using adapter: ${adapter}.`);
  rationale.push(`Task profile: ${profile.label}.`);
  rationale.push(`Planner: ${planner.source}${typeof planner.confidence === "number" ? ` (confidence ${planner.confidence.toFixed(2)})` : ""}.`);
  if (planner.reason) {
    rationale.push(`Planner reason: ${planner.reason}`);
  }
  if (planner.warning) {
    rationale.push(`Planner warning: ${planner.warning}`);
  }
  rationale.push(`Selected ${modules.length} module lane${modules.length === 1 ? "" : "s"}: ${modules.map((module) => module.path).join(", ")}.`);
  if (analysis.sharedFiles.length > 0) {
    rationale.push("Protected detected shared files so normal agents cannot edit them directly.");
  }
  if (analysis.verify.length > 0) {
    rationale.push("Copied detected verification commands from repository analysis.");
  }
  if (profile.verificationHint) {
    rationale.push(profile.verificationHint);
  }
  const generators = inferGenerators(analysis);
  if (generators.routes) {
    rationale.push(`Enabled route generation at ${generators.routes.output}.`);
  }

  return rationale;
}

function inferGenerators(analysis: RepoAnalysis): TaskPlan["generators"] {
  const generatedRoutes = analysis.sharedFiles.find((file) => file.endsWith("src/generated/routes.ts") || file === "src/generated/routes.ts");
  if (!generatedRoutes) {
    return {};
  }

  return {
    routes: {
      output: generatedRoutes,
    },
  };
}

function inferTaskProfile(goal: string, modules: ModuleCandidate[]): TaskProfile {
  const tokens = tokenize(goal);
  const modulePaths = modules.map((module) => module.path).join(" ");

  if (matchesAny(tokens, ["tui", "ui", "interface", "dashboard", "screen", "ink"]) || modulePaths.includes("commands/tui")) {
    return {
      kind: "tui",
      label: "terminal UI",
      focus: "Improve the Ink terminal experience, input flow, and visible user states.",
      mayRead: ["README.md", "IDEA.md", "src/commands/**", "src/commands/tui.tsx", "src/commands/status.ts"],
      preferredOutputs: ["agent-output/manifest.json"],
      extraProtected: ["package.json", "package-lock.json"],
      verificationHint: "UI task: keep CLI command behavior unchanged unless the task explicitly asks for command changes.",
    };
  }

  if (matchesAny(tokens, ["command", "cli", "apply", "run", "status", "doctor", "preview", "explain", "diff"])) {
    return {
      kind: tokens.has("diff") ? "diff" : "command",
      label: tokens.has("diff") ? "diff command" : "CLI command",
      focus: "Implement command behavior, option parsing, user-facing output, and command wiring.",
      mayRead: ["README.md", "IDEA.md", "src/commands/**", "src/index.ts", "src/schemas/**", "src/validation/**"],
      preferredOutputs: ["agent-output/manifest.json"],
      extraProtected: ["src/commands/tui.tsx"],
      verificationHint: "Command task: update command wiring and keep output concise and scriptable.",
    };
  }

  if (matchesAny(tokens, ["schema", "manifest", "yaml", "plan", "config"])) {
    return {
      kind: "schema",
      label: "schema/configuration",
      focus: "Update schemas, validation contracts, and related config handling.",
      mayRead: ["README.md", "IDEA.md", "src/schemas/**", "src/validation/**", "src/commands/validate-plan.ts", ".paraflow/schemas/**"],
      preferredOutputs: ["agent-output/manifest.json"],
      extraProtected: ["src/commands/tui.tsx"],
      verificationHint: "Schema task: preserve backward compatibility where possible.",
    };
  }

  if (matchesAny(tokens, ["validate", "validation", "ownership", "protected", "forbidden", "rule", "rules"])) {
    return {
      kind: "validation",
      label: "validation/rules",
      focus: "Update safety checks, validation rules, and failure messages.",
      mayRead: ["README.md", "IDEA.md", "src/validation/**", "src/schemas/**", "src/commands/validate-plan.ts", "src/commands/doctor.ts"],
      preferredOutputs: ["agent-output/manifest.json"],
      extraProtected: ["src/commands/tui.tsx"],
      verificationHint: "Validation task: prefer explicit errors with actionable fixes.",
    };
  }

  if (matchesAny(tokens, ["generator", "generate", "routes", "route", "compose", "composition"])) {
    return {
      kind: "generator",
      label: "generator/composition",
      focus: "Update generated artifacts, composition behavior, and manifest-driven outputs.",
      mayRead: ["README.md", "IDEA.md", "src/generators/**", "src/commands/compose.ts", "src/schemas/**"],
      preferredOutputs: ["agent-output/manifest.json"],
      extraProtected: ["src/commands/tui.tsx"],
      verificationHint: "Generator task: keep generated files deterministic.",
    };
  }

  if (matchesAny(tokens, ["test", "tests", "coverage", "spec"])) {
    return {
      kind: "test",
      label: "tests/verification",
      focus: "Add or adjust verification coverage while minimizing production changes.",
      mayRead: ["README.md", "IDEA.md", "src/**", "test/**", "tests/**", "__tests__/**"],
      preferredOutputs: ["agent-output/manifest.json"],
      extraProtected: [],
      verificationHint: "Test task: avoid unrelated implementation refactors.",
    };
  }

  if (matchesAny(tokens, ["readme", "docs", "documentation", "guide"])) {
    return {
      kind: "docs",
      label: "documentation",
      focus: "Improve docs, examples, and user-facing explanations.",
      mayRead: ["README.md", "IDEA.md", "docs/**", "src/commands/**"],
      preferredOutputs: ["agent-output/manifest.json"],
      extraProtected: ["package.json", "package-lock.json", "src/generated/**"],
      verificationHint: "Documentation task: code changes should be avoided unless examples require them.",
    };
  }

  return {
    kind: "general",
    label: "general implementation",
    focus: "Make the smallest safe implementation scoped to the selected module lane.",
    mayRead: ["README.md", "IDEA.md", "contracts/**", "src/core/**", "src/schemas/**"],
    preferredOutputs: ["agent-output/manifest.json"],
    extraProtected: [],
  };
}

function inferOwnedGlobs(module: ModuleCandidate, profile: TaskProfile): string[] {
  if (profile.kind === "tui" && module.path === "src/commands") {
    return ["src/commands/tui.tsx"];
  }

  if (profile.kind === "diff") {
    if (module.path === "src/commands") {
      return ["src/commands/diff.ts", "src/commands/**"];
    }
    if (module.path === "src/schemas") {
      return ["src/schemas/agent-diff.ts", "src/schemas/**"];
    }
    if (module.path === "src/validation") {
      return ["src/validation/diffs.ts", "src/validation/**"];
    }
  }

  return [`${module.path}/**`];
}

function inferMayRead(module: ModuleCandidate, profile: TaskProfile): string[] {
  return unique([...profile.mayRead, `${module.path}/**`]).filter((path) => !path.startsWith(`${module.path}/`) || path !== `${module.path}/**`);
}

function buildAgentTask(goal: string, laneTask: string, module: ModuleCandidate, profile: TaskProfile): string {
  return [
    `Lane-specific task: ${laneTask}`,
    "",
    `Original request: ${goal}`,
    "",
    `Task profile: ${profile.label}.`,
    `Lane: ${module.path}.`,
    `Focus: ${profile.focus}`,
    "",
    "Rules:",
    `- Edit only files owned by this lane unless the plan explicitly allows more.`,
    "- Keep shared/protected files untouched.",
    "- Preserve existing public CLI behavior unless this task explicitly changes it.",
    "- Emit agent-output/manifest.json when complete.",
  ].join("\n");
}

function createRunId(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const suffix = new Date().toISOString().replaceAll(/[-:]/g, "").slice(0, 15);

  return `${slug || "paraflow-run"}-${suffix}`;
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

function matchesAny(tokens: Set<string>, values: string[]): boolean {
  return values.some((value) => tokens.has(value));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
