import { statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { analyzeRepository, type RepoAnalysis } from "./analyze.js";
import { detectAutoAdapter, listAdapters } from "./adapters.js";
import { listRunStatuses } from "./status.js";

export type DoctorStatus = "pass" | "warn" | "fail" | "info";

export type DoctorCheck = {
  status: DoctorStatus;
  label: string;
  detail: string;
  fix?: string;
};

export type DoctorSection = {
  title: string;
  checks: DoctorCheck[];
};

export type DoctorReport = {
  status: "ready" | "needs_attention" | "blocked";
  sections: DoctorSection[];
};

export async function runDoctor(cwd: string): Promise<DoctorReport> {
  const sections: DoctorSection[] = [];
  const git = await inspectGit(cwd);
  let analysis: RepoAnalysis | undefined;

  sections.push({
    title: "Repository",
    checks: [
      git.isRepo
        ? {
            status: "pass",
            label: "Git repository",
            detail: `On ${git.branch ?? "unknown branch"}.`,
          }
        : {
            status: "fail",
            label: "Git repository",
            detail: "Paraflow needs git worktrees, but this directory is not a git repository.",
            fix: "Run git init, commit your base project, then rerun paraflow doctor.",
          },
      git.isRepo && git.dirtyFiles > 0
        ? {
            status: "warn",
            label: "Working tree",
            detail: `${git.dirtyFiles} uncommitted file${git.dirtyFiles === 1 ? "" : "s"} detected.`,
            fix: "Commit or stash unrelated work before running real agents.",
          }
        : {
            status: git.isRepo ? "pass" : "info",
            label: "Working tree",
            detail: git.isRepo ? "No uncommitted files detected." : "Skipped because this is not a git repository.",
          },
    ],
  });

  const metadataChecks: DoctorCheck[] = [
    await existsCheck(cwd, ".paraflow/config.yml", "Paraflow config", "Run paraflow init or paraflow bootstrap."),
    await existsCheck(cwd, ".paraflow/ownership.yml", "Ownership config", "Run paraflow init or paraflow bootstrap."),
    await existsCheck(cwd, ".paraflow/schemas/manifest.schema.json", "Manifest schema", "Run paraflow init or paraflow bootstrap."),
  ];
  sections.push({ title: "Paraflow Metadata", checks: metadataChecks });

  try {
    analysis = await analyzeRepository(cwd, { write: false });
    sections.push(buildProjectSection(cwd, analysis));
    sections.push(buildVerificationSection(cwd, analysis));
  } catch (error) {
    sections.push({
      title: "Project Analysis",
      checks: [
        {
          status: "fail",
          label: "Repository analysis",
          detail: error instanceof Error ? error.message : "Could not analyze repository.",
          fix: "Fix invalid project metadata, then rerun paraflow doctor.",
        },
      ],
    });
  }

  sections.push(await buildAdapterSection(cwd));
  sections.push(await buildRunSection(cwd));

  return {
    status: summarizeStatus(sections),
    sections,
  };
}

function buildProjectSection(cwd: string, analysis: RepoAnalysis): DoctorSection {
  const generatedRoutes = analysis.sharedFiles.find((file) => file.endsWith("src/generated/routes.ts") || file === "src/generated/routes.ts");
  const checks: DoctorCheck[] = [
    analysis.packageManager === "unknown"
      ? {
          status: "warn",
          label: "Package manager",
          detail: "No package.json or known lockfile detected.",
          fix: "Run paraflow bootstrap for a minimal TypeScript app, or add project metadata.",
        }
      : {
          status: "pass",
          label: "Package manager",
          detail: `Detected ${analysis.packageManager}.`,
        },
    analysis.modules.length === 0
      ? {
          status: "warn",
          label: "Module lanes",
          detail: "No obvious module boundaries were detected.",
          fix: "Create feature folders such as src/features/auth, or write a custom task plan.",
        }
      : {
          status: "pass",
          label: "Module lanes",
          detail: `${analysis.modules.length} lane${analysis.modules.length === 1 ? "" : "s"} detected: ${analysis.modules
            .slice(0, 5)
            .map((module) => module.path)
            .join(", ")}${analysis.modules.length > 5 ? ", ..." : ""}.`,
        },
    generatedRoutes
      ? {
          status: "pass",
          label: "Route generation",
          detail: `Detected ${generatedRoutes} for manifest-driven route composition.`,
        }
      : {
          status: "info",
          label: "Route generation",
          detail: "No generated route file detected.",
          fix: "Use paraflow bootstrap or add src/generated/routes.ts if this repo should compose routes from manifests.",
        },
  ];

  checks.push({
    status: analysis.sharedFiles.length > 0 ? "pass" : "info",
    label: "Shared files",
    detail:
      analysis.sharedFiles.length > 0
        ? `${analysis.sharedFiles.length} shared/protected file${analysis.sharedFiles.length === 1 ? "" : "s"} detected.`
        : "No shared files detected.",
  });

  return {
    title: "Project Shape",
    checks: checks.map((check) => addDependencyHint(cwd, check)),
  };
}

function buildVerificationSection(cwd: string, analysis: RepoAnalysis): DoctorSection {
  const hasPackageJson = pathLooksPresent(cwd, "package.json");
  const checks: DoctorCheck[] = [
    analysis.verify.length === 0
      ? {
          status: "warn",
          label: "Verify commands",
          detail: "No common scripts were detected in package.json.",
          fix: "Add one of: typecheck, test, lint, build, or format:check.",
        }
      : {
          status: "pass",
          label: "Verify commands",
          detail: analysis.verify.join(", "),
        },
  ];

  if (hasPackageJson) {
    checks.push({
      status: pathLooksPresent(cwd, "node_modules") ? "pass" : "warn",
      label: "Dependencies",
      detail: pathLooksPresent(cwd, "node_modules") ? "node_modules is present." : "node_modules is missing.",
      fix: pathLooksPresent(cwd, "node_modules") ? undefined : `Run ${installCommand(analysis.packageManager)} before verification.`,
    });
  }

  return {
    title: "Verification",
    checks,
  };
}

async function buildAdapterSection(cwd: string): Promise<DoctorSection> {
  const checks: DoctorCheck[] = [];

  try {
    const adapters = await listAdapters(cwd);
    checks.push(
      adapters.length > 0
        ? {
            status: "pass",
            label: "Configured adapters",
            detail: adapters.map((adapter) => adapter.name).join(", "),
          }
        : {
            status: "warn",
            label: "Configured adapters",
            detail: "No adapters are configured.",
            fix: "Run paraflow init or paraflow bootstrap.",
          },
    );

    if (adapters.some((adapter) => adapter.name === "auto")) {
      const detection = await detectAutoAdapter(cwd);
      checks.push(
        detection.selected
          ? {
              status: "pass",
              label: "Auto adapter",
              detail: `Will use ${detection.selected}.`,
            }
          : {
              status: "warn",
              label: "Auto adapter",
              detail: `No real agent CLI found. Checked: ${detection.candidates
                .map((candidate) => candidate.command ?? candidate.name)
                .join(", ")}.`,
              fix: "Install Codex, Claude Code, Cursor Agent, or run with --adapter noop for a local smoke test.",
            },
      );
    }
  } catch (error) {
    checks.push({
      status: "fail",
      label: "Adapter config",
      detail: error instanceof Error ? error.message : "Could not read adapter config.",
      fix: "Fix .paraflow/config.yml, then rerun paraflow doctor.",
    });
  }

  return {
    title: "Adapters",
    checks,
  };
}

async function buildRunSection(cwd: string): Promise<DoctorSection> {
  const checks: DoctorCheck[] = [];
  const runs = await listRunStatuses(cwd);
  checks.push(
    runs.length === 0
      ? {
          status: "pass",
          label: "Saved runs",
          detail: "No previous runs found.",
        }
      : {
          status: "info",
          label: "Saved runs",
          detail: `${runs.length} previous run${runs.length === 1 ? "" : "s"} found. Latest: ${runs[runs.length - 1]?.runId}.`,
        },
  );

  const worktreeCount = await countDirectoryChildren(join(cwd, ".paraflow", "worktrees"));
  checks.push(
    worktreeCount > 0
      ? {
          status: "warn",
          label: "Worktree artifacts",
          detail: `${worktreeCount} worktree director${worktreeCount === 1 ? "y" : "ies"} found under .paraflow/worktrees.`,
          fix: "Run paraflow clean --run <runId> after you are done with a run.",
        }
      : {
          status: "pass",
          label: "Worktree artifacts",
          detail: "No leftover worktree directories found.",
        },
  );

  return {
    title: "Run State",
    checks,
  };
}

async function inspectGit(cwd: string): Promise<{ isRepo: boolean; branch?: string; dirtyFiles: number }> {
  const isRepo = await execa("git", ["rev-parse", "--is-inside-work-tree"], { cwd, reject: false });
  if (isRepo.exitCode !== 0 || isRepo.stdout.trim() !== "true") {
    return { isRepo: false, dirtyFiles: 0 };
  }

  const branch = await execa("git", ["branch", "--show-current"], { cwd, reject: false });
  const status = await execa("git", ["status", "--porcelain"], { cwd, reject: false });

  return {
    isRepo: true,
    branch: branch.stdout.trim() || undefined,
    dirtyFiles: status.stdout.trim() ? status.stdout.trim().split("\n").length : 0,
  };
}

async function existsCheck(cwd: string, relativePath: string, label: string, fix: string): Promise<DoctorCheck> {
  return (await pathExists(join(cwd, relativePath)))
    ? {
        status: "pass",
        label,
        detail: `${relativePath} exists.`,
      }
    : {
        status: "fail",
        label,
        detail: `${relativePath} is missing.`,
        fix,
      };
}

function summarizeStatus(sections: DoctorSection[]): DoctorReport["status"] {
  const checks = sections.flatMap((section) => section.checks);
  if (checks.some((check) => check.status === "fail")) {
    return "blocked";
  }
  if (checks.some((check) => check.status === "warn")) {
    return "needs_attention";
  }

  return "ready";
}

function installCommand(packageManager: RepoAnalysis["packageManager"]): string {
  switch (packageManager) {
    case "pnpm":
      return "pnpm install";
    case "yarn":
      return "yarn install";
    case "bun":
      return "bun install";
    case "npm":
    case "unknown":
      return "npm install";
  }
}

function addDependencyHint(cwd: string, check: DoctorCheck): DoctorCheck {
  if (check.label !== "Package manager" || check.status !== "pass") {
    return check;
  }

  return pathLooksPresent(cwd, "package.json") && !pathLooksPresent(cwd, "node_modules")
    ? {
        ...check,
        detail: `${check.detail} Dependencies are not installed yet.`,
      }
    : check;
}

function pathLooksPresent(cwd: string, relativePath: string): boolean {
  try {
    statSyncSafe(join(cwd, relativePath));
    return true;
  } catch {
    return false;
  }
}

function statSyncSafe(path: string): void {
  statSync(path);
}

async function countDirectoryChildren(path: string): Promise<number> {
  if (!(await pathExists(path))) {
    return 0;
  }

  const entries = await readdir(path, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).length;
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
