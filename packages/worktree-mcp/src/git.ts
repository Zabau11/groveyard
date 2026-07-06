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

function isExecError(error: unknown): error is Error & { stdout?: string; stderr?: string } {
  return error instanceof Error && ("stdout" in error || "stderr" in error);
}
