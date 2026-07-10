import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
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
  try {
    return await runGit(repoPath, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    if (error instanceof GitCommandError) {
      const details = error.output ? `\nGit output:\n${error.output}` : "";
      throw new Error(
        [
          `Cannot resolve Groveyard repoPath "${repoPath}".`,
          "repoPath is resolved on the MCP server process filesystem, not on a remote caller's filesystem.",
          "Run @groveyard/mcp as a local stdio server with its cwd set to the repository, set GROVEYARD_REPO, or pass a path visible to that server.",
        ].join(" ") + details,
      );
    }

    throw error;
  }
}

export type GitWorktreeRecord = {
  path: string;
  head: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
  primary: boolean;
};

export type GitWorktreeGroup = {
  primaryPath: string;
  commonGitDirectory: string;
  current: GitWorktreeRecord;
  worktrees: GitWorktreeRecord[];
};

export function parseWorktreeListPorcelain(output: string): GitWorktreeRecord[] {
  const blocks = output.trim().split(/\r?\n\r?\n/).filter(Boolean);
  return blocks.map((block, index) => {
    const values = new Map<string, string>();
    const flags = new Set<string>();
    for (const line of block.split(/\r?\n/)) {
      const separator = line.indexOf(" ");
      if (separator === -1) flags.add(line);
      else values.set(line.slice(0, separator), line.slice(separator + 1));
    }
    const path = values.get("worktree");
    const head = values.get("HEAD");
    if (!path || !head) throw new Error("Malformed git worktree list --porcelain output.");
    const branchRef = values.get("branch");
    return {
      path,
      head,
      branch: branchRef?.replace(/^refs\/heads\//, ""),
      bare: flags.has("bare"),
      detached: flags.has("detached") || !branchRef,
      primary: index === 0,
    };
  });
}

export async function resolveWorktreeGroup(repoPath: string): Promise<GitWorktreeGroup> {
  const worktreeRoot = await resolveRepoRoot(repoPath);
  const rawCommonDirectory = await runGit(worktreeRoot, ["rev-parse", "--git-common-dir"]);
  const commonGitDirectory = await realpath(isAbsolute(rawCommonDirectory) ? rawCommonDirectory : resolve(worktreeRoot, rawCommonDirectory));
  const parsed = parseWorktreeListPorcelain(await runGit(worktreeRoot, ["worktree", "list", "--porcelain"]));
  const worktrees = await Promise.all(parsed.map(async (record) => ({ ...record, path: await realpath(record.path) })));
  const canonicalRoot = await realpath(worktreeRoot);
  const current = worktrees.find((record) => record.path === canonicalRoot);
  const primary = worktrees.find((record) => record.primary);

  if (!current) throw new Error(`Worktree ${canonicalRoot} is not registered in git worktree list.`);
  if (!primary) throw new Error("Git worktree group has no primary checkout.");
  if (current.bare || primary.bare) throw new Error("Bare repositories are not supported by Groveyard.");

  return { primaryPath: primary.path, commonGitDirectory, current, worktrees };
}

export async function getCurrentBranch(repoRoot: string): Promise<string> {
  return runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export async function getRefSha(repoRoot: string, ref: string): Promise<string> {
  return runGit(repoRoot, ["rev-parse", ref]);
}

export async function gitRefExists(repoRoot: string, ref: string): Promise<boolean> {
  try {
    await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch (error) {
    if (error instanceof GitCommandError) {
      return false;
    }

    throw error;
  }
}

export async function isBranchMergedInto(repoRoot: string, branch: string, targetBranch: string): Promise<boolean> {
  const targetRef = await resolveExistingBranchRef(repoRoot, targetBranch);

  if (!targetRef) {
    return false;
  }

  try {
    await runGit(repoRoot, ["merge-base", "--is-ancestor", branch, targetRef]);
    return true;
  } catch (error) {
    if (error instanceof GitCommandError) {
      return false;
    }

    throw error;
  }
}

export async function branchHasUniqueCommits(repoRoot: string, baseBranch: string, branch: string): Promise<boolean> {
  const baseRef = await resolveExistingBranchRef(repoRoot, baseBranch);

  if (!baseRef) {
    return false;
  }

  try {
    const count = await runGit(repoRoot, ["rev-list", "--count", `${baseRef}..${branch}`]);
    return Number(count) > 0;
  } catch (error) {
    if (error instanceof GitCommandError) {
      return false;
    }

    throw error;
  }
}

export async function branchHasCommitsAfter(repoRoot: string, baseCommit: string, branch: string): Promise<boolean> {
  try {
    const count = await runGit(repoRoot, ["rev-list", "--count", `${baseCommit}..${branch}`]);
    return Number(count) > 0;
  } catch (error) {
    if (error instanceof GitCommandError) {
      return false;
    }

    throw error;
  }
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

export async function isWorktreeClean(worktreePath: string): Promise<boolean> {
  return (await gitStatusShort(worktreePath)).length === 0;
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
    return await runGit(worktreePath, ["diff", "--no-index", "--binary", "--", process.platform === "win32" ? "NUL" : "/dev/null", filePath]);
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

async function resolveExistingBranchRef(repoRoot: string, branch: string): Promise<string | null> {
  const candidates = [branch, `origin/${branch}`];

  for (const candidate of candidates) {
    if (await gitRefExists(repoRoot, candidate)) {
      return candidate;
    }
  }

  return null;
}
