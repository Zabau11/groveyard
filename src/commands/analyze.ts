import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import fg from "fast-glob";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "unknown";

export type ModuleCandidate = {
  name: string;
  path: string;
  kind: "feature" | "package" | "app" | "source";
};

export type RepoAnalysis = {
  version: 1;
  packageManager: PackageManager;
  verify: string[];
  modules: ModuleCandidate[];
  sharedFiles: string[];
  protected: string[];
  notes: string[];
};

const ignoredDirectories = ["**/node_modules/**", "**/.git/**", "**/.agentx/**", "**/dist/**", "**/build/**"];

const defaultProtected = [".agentx/**", "contracts/**", "src/generated/**", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"];

type AnalyzeOptions = {
  write?: boolean;
};

export async function analyzeRepository(cwd: string, options: AnalyzeOptions = {}): Promise<RepoAnalysis> {
  const packageManager = await detectPackageManager(cwd);
  const packageJson = await readPackageJson(cwd);
  const verify = detectVerifyCommands(packageManager, packageJson);
  const modules = await detectModules(cwd);
  const sharedFiles = await detectSharedFiles(cwd);
  const protectedPaths = unique([...defaultProtected, ...detectProtectedFromSharedFiles(sharedFiles)]);
  const notes = buildNotes(modules, sharedFiles, verify);

  const analysis: RepoAnalysis = {
    version: 1,
    packageManager,
    verify,
    modules,
    sharedFiles,
    protected: protectedPaths,
    notes,
  };

  if (options.write !== false) {
    await mkdir(join(cwd, ".agentx"), { recursive: true });
    await writeFile(join(cwd, ".agentx", "analysis.json"), `${JSON.stringify(analysis, null, 2)}\n`);
  }

  return analysis;
}

async function detectPackageManager(cwd: string): Promise<PackageManager> {
  if (await pathExists(join(cwd, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (await pathExists(join(cwd, "yarn.lock"))) {
    return "yarn";
  }
  if (await pathExists(join(cwd, "bun.lockb"))) {
    return "bun";
  }
  if (await pathExists(join(cwd, "package-lock.json"))) {
    return "npm";
  }

  const packageJson = await readPackageJson(cwd);
  const packageManager = typeof packageJson?.packageManager === "string" ? packageJson.packageManager : "";
  if (packageManager.startsWith("pnpm@")) {
    return "pnpm";
  }
  if (packageManager.startsWith("yarn@")) {
    return "yarn";
  }
  if (packageManager.startsWith("bun@")) {
    return "bun";
  }
  if (packageManager.startsWith("npm@")) {
    return "npm";
  }

  return packageJson ? "npm" : "unknown";
}

async function readPackageJson(cwd: string): Promise<Record<string, unknown> | undefined> {
  const packageJsonPath = join(cwd, "package.json");
  if (!(await pathExists(packageJsonPath))) {
    return undefined;
  }

  return JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
}

function detectVerifyCommands(packageManager: PackageManager, packageJson: Record<string, unknown> | undefined): string[] {
  const scripts = packageJson && typeof packageJson.scripts === "object" && packageJson.scripts !== null ? packageJson.scripts : {};
  const scriptNames = Object.keys(scripts);
  const preferred = ["format:check", "lint", "typecheck", "test", "build"];

  return preferred.filter((script) => scriptNames.includes(script)).map((script) => renderScriptCommand(packageManager, script));
}

function renderScriptCommand(packageManager: PackageManager, script: string): string {
  switch (packageManager) {
    case "pnpm":
      return `pnpm ${script}`;
    case "yarn":
      return `yarn ${script}`;
    case "bun":
      return `bun run ${script}`;
    case "npm":
    case "unknown":
      return `npm run ${script}`;
  }
}

async function detectModules(cwd: string): Promise<ModuleCandidate[]> {
  const candidates: ModuleCandidate[] = [];

  candidates.push(...(await childDirectories(cwd, "src/features")).map((name) => ({ name, path: `src/features/${name}`, kind: "feature" as const })));
  candidates.push(...(await childDirectories(cwd, "packages")).map((name) => ({ name, path: `packages/${name}`, kind: "package" as const })));
  candidates.push(...(await childDirectories(cwd, "apps")).map((name) => ({ name, path: `apps/${name}`, kind: "app" as const })));

  if (candidates.length === 0 && (await pathExists(join(cwd, "src")))) {
    const sourceChildren = await childDirectories(cwd, "src");
    if (sourceChildren.length > 0) {
      candidates.push(...sourceChildren.map((name) => ({ name, path: `src/${name}`, kind: "source" as const })));
    } else {
      candidates.push({ name: "src", path: "src", kind: "source" });
    }
  }

  return candidates.sort((left, right) => left.path.localeCompare(right.path));
}

async function childDirectories(cwd: string, relativePath: string): Promise<string[]> {
  const fullPath = join(cwd, relativePath);
  if (!(await pathExists(fullPath))) {
    return [];
  }

  const entries = await readdir(fullPath, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name).sort();
}

async function detectSharedFiles(cwd: string): Promise<string[]> {
  const patterns = [
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "tsconfig*.json",
    "**/routes.{ts,tsx,js,jsx}",
    "**/router.{ts,tsx,js,jsx}",
    "**/navigation.{ts,tsx,js,jsx}",
    "**/permissions.{ts,tsx,js,jsx}",
    "**/registry.{ts,tsx,js,jsx}",
    "**/plugin-registry.{ts,tsx,js,jsx}",
    "**/index.{ts,tsx,js,jsx}",
    "**/config.{ts,tsx,js,jsx,json,yml,yaml}",
  ];

  const matches = await fg(patterns, {
    cwd,
    onlyFiles: true,
    dot: true,
    ignore: ignoredDirectories,
  });

  return unique(matches).sort();
}

function detectProtectedFromSharedFiles(sharedFiles: string[]): string[] {
  return sharedFiles.filter((file) => isPackageFile(file) || file.includes("/generated/") || file.startsWith("contracts/"));
}

function buildNotes(modules: ModuleCandidate[], sharedFiles: string[], verify: string[]): string[] {
  const notes: string[] = [];

  if (modules.length === 0) {
    notes.push("No obvious module boundaries were detected. Start with a hand-written task plan.");
  }

  if (sharedFiles.length > 0) {
    notes.push("Shared files were detected. Normal agents should not edit these directly unless explicitly approved.");
  }

  if (verify.length === 0) {
    notes.push("No common verification scripts were detected in package.json.");
  }

  return notes;
}

function isPackageFile(file: string): boolean {
  return ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"].includes(file);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
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
