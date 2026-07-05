import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ModuleCandidate, RepoAnalysis } from "./analyze.js";

export type PlannerMode = "auto" | "heuristic" | "llm";

export type ModuleSelection = {
  modules: ModuleCandidate[];
  source: "heuristic" | "llm";
  confidence?: number;
  reason?: string;
  warning?: string;
};

type SelectModulesOptions = {
  cwd: string;
  mode?: PlannerMode;
};

type LlmPlannerAttempt = {
  selection?: ModuleSelection;
  warning?: string;
};

const llmPlannerResponseSchema = z.object({
  selectedModules: z.array(z.string()).min(1),
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string().optional(),
  needsConfirmation: z.boolean().optional(),
});

export function parsePlannerMode(value: string): PlannerMode {
  if (value === "auto" || value === "heuristic" || value === "llm") {
    return value;
  }

  throw new Error(`Invalid planner "${value}". Expected auto, llm, or heuristic.`);
}

export async function selectModulesForGoal(goal: string, analysis: RepoAnalysis, options: SelectModulesOptions): Promise<ModuleSelection> {
  const mode = options.mode ?? "auto";
  if (mode === "heuristic") {
    return {
      modules: heuristicSelectModules(goal, analysis.modules),
      source: "heuristic",
    };
  }

  const llmAttempt = await tryLlmSelectModules(goal, analysis, options.cwd);
  if (llmAttempt.selection) {
    return llmAttempt.selection;
  }

  const warning = llmAttempt.warning ?? "LLM planner unavailable; used heuristic planner.";
  const fallback = {
    modules: heuristicSelectModules(goal, analysis.modules),
    source: "heuristic" as const,
    warning,
  };

  if (mode === "llm") {
    return {
      ...fallback,
      warning: `LLM planner failed (${warning}); used heuristic planner so the run can continue.`,
    };
  }

  return fallback;
}

function heuristicSelectModules(goal: string, modules: ModuleCandidate[]): ModuleCandidate[] {
  if (modules.length <= 1) {
    return modules;
  }

  const tokens = tokenize(goal);
  const semanticMatches = modules.filter((module) => moduleMatchesGoal(module, tokens));
  if (semanticMatches.length > 0) {
    return semanticMatches;
  }

  const directMatches = modules.filter((module) => tokens.has(module.name.toLowerCase()) || tokens.has(module.path.toLowerCase()));
  if (directMatches.length > 0) {
    return directMatches;
  }

  return modules.slice(0, 3);
}

function moduleMatchesGoal(module: ModuleCandidate, tokens: Set<string>): boolean {
  const path = module.path.toLowerCase();
  if (path === "src/commands") {
    return matchesAny(tokens, ["command", "commands", "cli", "run", "apply", "status", "doctor", "preview", "explain", "diff", "tui", "ui", "dashboard"]);
  }
  if (path === "src/schemas") {
    return matchesAny(tokens, ["schema", "schemas", "manifest", "yaml", "plan", "config", "diff"]);
  }
  if (path === "src/validation") {
    return matchesAny(tokens, ["validate", "validation", "ownership", "protected", "forbidden", "rule", "rules", "diff"]);
  }
  if (path === "src/generators") {
    return matchesAny(tokens, ["generator", "generators", "generate", "routes", "route", "compose", "composition"]);
  }

  return false;
}

function matchesAny(tokens: Set<string>, values: string[]): boolean {
  return values.some((value) => tokens.has(value));
}

async function tryLlmSelectModules(goal: string, analysis: RepoAnalysis, cwd: string): Promise<LlmPlannerAttempt> {
  const env = await loadPlannerEnv(cwd);
  if (env.PARAFLOW_PLANNER_PROVIDER !== "mistral" || !env.MISTRAL_API_KEY) {
    return {};
  }

  const model = env.PARAFLOW_PLANNER_MODEL || "codestral-latest";
  let response: Response;
  try {
    response = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.MISTRAL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "You are Paraflow's repository planner. Select the minimal safe module lanes for a coding task. Respond with only JSON: {\"selectedModules\":[\"path\"],\"confidence\":0.0,\"reason\":\"short reason\",\"needsConfirmation\":false}. Only choose paths from the provided modules.",
          },
          {
            role: "user",
            content: JSON.stringify({
              goal,
              modules: analysis.modules,
              sharedFiles: analysis.sharedFiles.slice(0, 80),
              protected: analysis.protected,
              verify: analysis.verify,
            }),
          },
        ],
      }),
    });
  } catch (error) {
    return { warning: error instanceof Error ? error.message : String(error) };
  }

  if (!response.ok) {
    return { warning: `Mistral planner request failed with ${response.status} ${response.statusText}` };
  }

  const body = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string;
      };
    }>;
  };
  const content = body.choices?.[0]?.message?.content;
  if (!content) {
    return { warning: "Mistral planner response did not include message content" };
  }

  const parsed = parseJsonObject(content);
  if (!parsed) {
    return { warning: "Mistral planner response was not valid JSON" };
  }

  const selection = llmPlannerResponseSchema.safeParse(parsed);
  if (!selection.success) {
    return { warning: "Mistral planner JSON did not match Paraflow's expected shape" };
  }

  const moduleMap = new Map(analysis.modules.map((module) => [module.path, module]));
  const modules = selection.data.selectedModules.map((path) => moduleMap.get(path)).filter((module): module is ModuleCandidate => Boolean(module));
  if (modules.length === 0) {
    return { warning: "Mistral planner did not choose any known module lanes" };
  }

  return {
    selection: {
      modules,
      source: "llm",
      confidence: selection.data.confidence,
      reason: selection.data.reason,
    },
  };
}

function parseJsonObject(content: string): unknown | undefined {
  const trimmed = content.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) {
      return undefined;
    }
    try {
      return JSON.parse(match[0]);
    } catch {
      return undefined;
    }
  }
}

async function loadPlannerEnv(cwd: string): Promise<Record<string, string>> {
  const env = { ...process.env } as Record<string, string>;
  const envPath = join(cwd, ".env");
  if (!(await pathExists(envPath))) {
    return env;
  }

  const raw = await readFile(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && !(key in env)) {
      env[key] = value;
    }
  }

  return env;
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9/._-]+/)
      .filter(Boolean),
  );
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
