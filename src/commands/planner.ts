import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import fg from "fast-glob";
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
    return heuristicSelectModules(goal, analysis.modules, options.cwd);
  }

  const llmAttempt = await tryLlmSelectModules(goal, analysis, options.cwd);
  if (llmAttempt.selection) {
    return llmAttempt.selection;
  }

  const warning = llmAttempt.warning ?? "LLM planner unavailable; used heuristic planner.";
  const fallback = await heuristicSelectModules(goal, analysis.modules, options.cwd);
  fallback.warning = fallback.warning ? `${warning} ${fallback.warning}` : warning;

  if (mode === "llm") {
    return {
      ...fallback,
      warning: `LLM planner failed (${warning}); used heuristic planner so the run can continue.`,
    };
  }

  return fallback;
}

async function heuristicSelectModules(goal: string, modules: ModuleCandidate[], cwd: string): Promise<ModuleSelection> {
  if (modules.length <= 1) {
    return {
      modules,
      source: "heuristic",
      reason: modules.length === 1 ? `Only one module lane was detected: ${modules[0]!.path}.` : "No module lanes were detected.",
    };
  }

  const tokens = tokenize(goal);
  const semanticMatches = modules.filter((module) => moduleMatchesGoal(module, tokens));
  if (semanticMatches.length > 0) {
    return {
      modules: semanticMatches,
      source: "heuristic",
      reason: `Matched task language to known Paraflow implementation lanes: ${semanticMatches.map((module) => module.path).join(", ")}.`,
    };
  }

  const scoredMatches = await scoreModulesForGoal(goal, tokens, modules, cwd);
  const selected = scoredMatches.filter((match) => match.score >= 2);
  if (selected.length > 0) {
    return {
      modules: selected.map((match) => match.module),
      source: "heuristic",
      confidence: Math.min(0.95, 0.55 + selected.length * 0.1),
      reason: selected.map((match) => `${match.module.path} matched ${match.terms.slice(0, 4).join(", ")}`).join("; "),
    };
  }

  return {
    modules: [modules[0]!],
    source: "heuristic",
    confidence: 0.25,
    reason: `No clear module lane matched the task, so Paraflow chose the first detected lane instead of inventing a split: ${modules[0]!.path}.`,
    warning: "No obvious ownership lane matched the task. Review the contract before handing it to an agent.",
  };
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

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

type ModuleScore = {
  module: ModuleCandidate;
  score: number;
  terms: string[];
};

async function scoreModulesForGoal(goal: string, tokens: Set<string>, modules: ModuleCandidate[], cwd: string): Promise<ModuleScore[]> {
  const clauses = splitGoalClauses(goal).map((clause) => expandTokens(tokenize(clause)));
  const expandedTokens = expandTokens(tokens);
  const fileKeywordMap = await loadModuleFileKeywords(cwd, modules);

  const scores = modules.map((module) => {
    const nameKeywords = expandTokens(new Set([module.name, ...splitIdentifier(module.name), ...splitIdentifier(module.path.split("/").at(-1) ?? module.name)]));
    const pathKeywords = expandTokens(new Set(module.path.split("/").flatMap((part) => splitIdentifier(part))));
    const fileKeywords = fileKeywordMap.get(module.path) ?? new Set<string>();
    const terms: string[] = [];
    let score = 0;

    for (const keyword of nameKeywords) {
      if (expandedTokens.has(keyword)) {
        score += 5;
        terms.push(keyword);
      }
    }

    for (const keyword of pathKeywords) {
      if (expandedTokens.has(keyword)) {
        score += 3;
        terms.push(keyword);
      }
    }

    let fileTermMatches = 0;
    for (const keyword of fileKeywords) {
      if (expandedTokens.has(keyword)) {
        fileTermMatches += 1;
        terms.push(keyword);
      }
    }
    score += Math.min(fileTermMatches * 2, 6);

    for (const clause of clauses) {
      const clauseNameHits = [...nameKeywords].filter((keyword) => clause.has(keyword)).length;
      const clauseFileHits = [...fileKeywords].filter((keyword) => clause.has(keyword)).length;
      if (clauseNameHits > 0 && clauseFileHits > 0) {
        score += 2;
      }
    }

    return {
      module,
      score,
      terms: unique(terms),
    };
  });

  return scores
    .filter((score) => score.score > 0)
    .sort((left, right) => right.score - left.score || left.module.path.localeCompare(right.module.path));
}

async function loadModuleFileKeywords(cwd: string, modules: ModuleCandidate[]): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();

  await Promise.all(
    modules.map(async (module) => {
      const entries = await fg(["**/*"], {
        cwd: join(cwd, module.path),
        onlyFiles: true,
        dot: true,
        deep: 4,
        ignore: ["node_modules/**", "dist/**", "build/**", ".next/**", "coverage/**"],
      });
      const keywords = new Set<string>();
      for (const entry of entries.slice(0, 200)) {
        for (const part of entry.split(/[/.]/g)) {
          for (const token of splitIdentifier(part)) {
            if (isUsefulToken(token)) {
              keywords.add(token);
              keywords.add(singularize(token));
            }
          }
        }
      }
      result.set(module.path, keywords);
    }),
  );

  return result;
}

function splitGoalClauses(goal: string): string[] {
  return goal
    .split(/\b(?:and|then|plus|also)\b|[,;]/i)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function expandTokens(tokens: Set<string>): Set<string> {
  const expanded = new Set<string>();
  for (const token of tokens) {
    for (const part of splitIdentifier(token)) {
      if (!isUsefulToken(part)) {
        continue;
      }
      expanded.add(part);
      expanded.add(singularize(part));
    }
  }
  return expanded;
}

function splitIdentifier(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function singularize(value: string): string {
  if (value.endsWith("ies") && value.length > 4) {
    return `${value.slice(0, -3)}y`;
  }
  if (value.endsWith("ses") && value.length > 4) {
    return value.slice(0, -2);
  }
  if (value.endsWith("s") && value.length > 3) {
    return value.slice(0, -1);
  }
  return value;
}

function isUsefulToken(value: string): boolean {
  return value.length > 1 && !stopWords.has(value);
}

const stopWords = new Set([
  "a",
  "an",
  "and",
  "the",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "from",
  "add",
  "fix",
  "change",
  "modify",
  "update",
  "create",
  "make",
  "new",
  "file",
  "files",
  "index",
  "component",
  "components",
]);

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
