import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";

type CleanResult = {
  runId: string;
  removedWorktrees: string[];
  removedPaths: string[];
  deletedBranch?: string;
};

export async function cleanRun(runId: string, cwd: string): Promise<CleanResult> {
  await ensureGitRepository(cwd);

  const runRoot = join(cwd, ".agentx", "runs", runId);
  const worktreeRoot = join(cwd, ".agentx", "worktrees", runId);
  const reportPath = join(cwd, ".agentx", "reports", `${runId}.md`);
  const branch = `agentx/${runId}`;
  const removedWorktrees = await removeRegisteredWorktrees(cwd, worktreeRoot);
  const removedPaths: string[] = [];

  for (const path of [runRoot, worktreeRoot, reportPath]) {
    if (await pathExists(path)) {
      await rm(path, { recursive: true, force: true });
      removedPaths.push(path);
    }
  }

  const deletedBranch = await deleteBranchIfExists(cwd, branch);

  return {
    runId,
    removedWorktrees,
    removedPaths,
    deletedBranch,
  };
}

async function removeRegisteredWorktrees(cwd: string, worktreeRoot: string): Promise<string[]> {
  const result = await execa("git", ["worktree", "list", "--porcelain"], { cwd });
  const worktrees = parseWorktreeList(result.stdout).filter((path) => path === worktreeRoot || path.startsWith(`${worktreeRoot}/`));
  const removed: string[] = [];

  for (const worktree of worktrees.sort((left, right) => right.length - left.length)) {
    const remove = await execa("git", ["worktree", "remove", "--force", worktree], { cwd, reject: false, all: true });
    if (remove.exitCode !== 0) {
      throw new Error(`Failed to remove worktree ${worktree}:\n${remove.all ?? ""}`);
    }
    removed.push(worktree);
  }

  return removed;
}

function parseWorktreeList(output: string): string[] {
  const worktrees: string[] = [];

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      worktrees.push(line.slice("worktree ".length));
    }
  }

  return worktrees;
}

async function deleteBranchIfExists(cwd: string, branch: string): Promise<string | undefined> {
  const exists = await execa("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd, reject: false });
  if (exists.exitCode !== 0) {
    return undefined;
  }

  const currentBranch = await execa("git", ["branch", "--show-current"], { cwd });
  if (currentBranch.stdout.trim() === branch) {
    throw new Error(`Refusing to delete the currently checked out branch: ${branch}`);
  }

  const result = await execa("git", ["branch", "-D", branch], { cwd, reject: false, all: true });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to delete branch ${branch}:\n${result.all ?? ""}`);
  }

  return branch;
}

async function ensureGitRepository(cwd: string): Promise<void> {
  const result = await execa("git", ["rev-parse", "--is-inside-work-tree"], { cwd, reject: false });
  if (result.exitCode !== 0 || result.stdout.trim() !== "true") {
    throw new Error("agentx clean must be executed inside a Git repository.");
  }
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
