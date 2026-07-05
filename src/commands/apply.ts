import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { z } from "zod";
import { selectRun } from "./select-run.js";
import { getRunStatus } from "./status.js";

const compositionSummarySchema = z.object({
  status: z.enum(["composed", "composed_with_skips", "failed"]),
  branch: z.string(),
  workspacePath: z.string(),
});

type ApplyOptions = {
  run?: string;
  force?: boolean;
};

type ApplyResult = {
  runId: string;
  files: string[];
  patchPath: string;
};

export async function applyRun(cwd: string, options: ApplyOptions = {}): Promise<ApplyResult> {
  const runId = options.run ?? (await selectRun(cwd, { kind: "composed", action: "apply" }));
  const detail = await getRunStatus(runId, cwd);

  if (!detail.composition) {
    throw new Error(`Run "${runId}" has not been composed yet. Run paraflow compose --run ${runId} first.`);
  }

  if (detail.composition.status === "failed") {
    throw new Error(`Run "${runId}" composition failed and cannot be applied.`);
  }

  if (!options.force && detail.verification?.status !== "passed") {
    throw new Error(`Run "${runId}" has not passed verification. Run paraflow verify --run ${runId}, or use --force.`);
  }

  await ensureCleanWorkingTree(cwd);

  const compositionPath = join(cwd, ".paraflow", "runs", runId, "composition.json");
  const composition = compositionSummarySchema.parse(JSON.parse(await readFile(compositionPath, "utf8")));
  if (!(await pathExists(composition.workspacePath))) {
    throw new Error(`Integration workspace not found: ${composition.workspacePath}`);
  }

  const patch = await createIntegrationPatch(composition.workspacePath);
  if (patch.trim().length === 0) {
    throw new Error(`Run "${runId}" has no integration changes to apply.`);
  }

  const tempDir = await mkdtemp(join(tmpdir(), "paraflow-apply-"));
  const patchPath = join(tempDir, `${runId}.patch`);
  await writeFile(patchPath, patch);

  try {
    await applyPatch(cwd, patchPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  return {
    runId,
    files: await changedFiles(cwd),
    patchPath: join(cwd, ".paraflow", "runs", runId, "agents"),
  };
}

async function ensureCleanWorkingTree(cwd: string): Promise<void> {
  const result = await execa("git", ["status", "--porcelain"], { cwd });
  if (result.stdout.trim().length > 0) {
    throw new Error("Refusing to apply into a dirty working tree. Commit or stash current changes first.");
  }
}

async function createIntegrationPatch(workspacePath: string): Promise<string> {
  const result = await execa("git", ["diff", "--binary", "HEAD"], { cwd: workspacePath });
  return result.stdout.length > 0 ? `${result.stdout}\n` : "";
}

async function applyPatch(cwd: string, patchPath: string): Promise<void> {
  const check = await execa("git", ["apply", "--check", patchPath], { cwd, reject: false, all: true });
  if (check.exitCode !== 0) {
    throw new Error(`Patch cannot be applied cleanly:\n${check.all ?? ""}`);
  }

  const apply = await execa("git", ["apply", patchPath], { cwd, reject: false, all: true });
  if (apply.exitCode !== 0) {
    throw new Error(`Patch failed to apply:\n${apply.all ?? ""}`);
  }
}

async function changedFiles(cwd: string): Promise<string[]> {
  const result = await execa("git", ["status", "--porcelain"], { cwd });
  return result.stdout
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .sort();
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
