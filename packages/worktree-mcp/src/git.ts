import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly cwd: string,
    readonly output: string,
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}

export async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 1024 * 1024 * 20,
    });

    return stdout.trim();
  } catch (error) {
    if (isExecError(error)) {
      const output = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
      throw new GitCommandError(`git ${args.join(" ")} failed in ${cwd}`, args, cwd, output);
    }

    throw error;
  }
}

export async function resolveRepoRoot(repoPath: string): Promise<string> {
  return runGit(repoPath, ["rev-parse", "--show-toplevel"]);
}

export async function getCurrentBranch(repoRoot: string): Promise<string> {
  return runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export async function assertCleanWorktree(repoRoot: string): Promise<void> {
  const status = await runGit(repoRoot, ["status", "--porcelain"]);

  if (status.length > 0) {
    throw new Error(`Repository has uncommitted changes. Commit or stash them before creating a worktree session:\n${status}`);
  }
}

export async function createGitWorktree(repoRoot: string, worktreePath: string, branch: string, baseBranch: string): Promise<void> {
  await runGit(repoRoot, ["worktree", "add", "-b", branch, worktreePath, baseBranch]);
}

export async function removeGitWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
}

export async function gitStatusShort(worktreePath: string): Promise<string> {
  return runGit(worktreePath, ["status", "--short"]);
}

export async function gitDiff(worktreePath: string): Promise<string> {
  const trackedDiff = await runGit(worktreePath, ["diff", "--binary", "HEAD"]);
  const untrackedFiles = await gitUntrackedFiles(worktreePath);
  const untrackedDiffs = await Promise.all(untrackedFiles.map((filePath) => gitDiffUntrackedFile(worktreePath, filePath)));

  return [trackedDiff, ...untrackedDiffs].filter(Boolean).join("\n");
}

export type GitCommitResult = {
  sha: string;
  message: string;
};

export async function commitAllChanges(worktreePath: string, message: string): Promise<GitCommitResult> {
  const status = await runGit(worktreePath, ["status", "--porcelain"]);

  if (!status) {
    throw new Error("No changes to commit.");
  }

  await runGit(worktreePath, ["add", "--all"]);
  await runGit(worktreePath, ["commit", "-m", message]);
  const sha = await runGit(worktreePath, ["rev-parse", "HEAD"]);

  return {
    sha,
    message,
  };
}

async function gitUntrackedFiles(worktreePath: string): Promise<string[]> {
  const stdout = await runGit(worktreePath, ["ls-files", "--others", "--exclude-standard"]);
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function gitDiffUntrackedFile(worktreePath: string, filePath: string): Promise<string> {
  try {
    return await runGit(worktreePath, ["diff", "--no-index", "--binary", "--", "/dev/null", filePath]);
  } catch (error) {
    if (error instanceof GitCommandError && error.output) {
      return error.output;
    }

    throw error;
  }
}

function isExecError(error: unknown): error is Error & { stdout?: string; stderr?: string } {
  return error instanceof Error && ("stdout" in error || "stderr" in error);
}
