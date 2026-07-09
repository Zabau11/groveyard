import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import {
  assertCleanWorktree,
  type GitCommitResult,
  commitAllChanges,
  createGitWorktree,
  getCurrentBranch,
  gitDiff,
  gitStatusShort,
  removeGitWorktree,
  resolveRepoRoot,
} from "./git.js";
import { JsonSessionStore } from "./session-store.js";
import type { SessionRecord } from "./sessions.js";
import { resolveExistingSessionPath, resolveWritableSessionPath, toSessionRelativePath } from "./path-safety.js";
import { loadConfig } from "./config.js";
import {
  type CommandRunResult,
  UnknownCommandProfileError,
  runCommandProfile as executeCommandProfile,
} from "./command-runner.js";

const metadataDirectory = ".groveyard";

export type CreateSessionInput = {
  repoPath?: string;
  taskName: string;
  baseBranch?: string;
};

export type SessionLookupInput = {
  repoPath?: string;
  sessionId: string;
};

export type SessionFileInput = SessionLookupInput & {
  path: string;
};

export type SessionWriteFileInput = SessionFileInput & {
  content: string;
};

export type RunCommandProfileInput = SessionLookupInput & {
  profile: string;
};

export type CommitSessionInput = SessionLookupInput & {
  message: string;
};

export type ContractStatus = {
  session: SessionRecord;
  readyToCommit: boolean;
  checks: {
    activeSession: boolean;
    statusReviewedAfterLatestMutation: boolean;
    diffReviewedAfterLatestMutation: boolean;
  };
  requiredActions: string[];
};

export class WorktreeSessionService {
  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const repoRoot = await this.resolveRepo(input.repoPath);
    const config = await loadConfig(repoRoot);

    if (!config.allowDirtyBase) {
      await assertCleanWorktree(repoRoot);
    }

    const taskSlug = slugify(input.taskName);
    const id = createSessionId();
    const suffix = id.replace(/^sess_/, "");
    const baseBranch = input.baseBranch ?? (await getCurrentBranch(repoRoot));
    const branch = `${config.branchPrefix}${taskSlug}-${suffix}`;
    const worktreePath = join(repoRoot, config.worktreesRoot, id);
    const now = new Date().toISOString();

    await mkdir(join(repoRoot, config.worktreesRoot), { recursive: true });
    await createGitWorktree(repoRoot, worktreePath, branch, baseBranch);

    const session: SessionRecord = {
      id,
      repoPath: repoRoot,
      worktreePath,
      branch,
      baseBranch,
      taskName: input.taskName,
      status: "active",
      createdAt: now,
      updatedAt: now,
      contract: {
        readPaths: [],
        listedPaths: [],
        writtenPaths: [],
        commandProfilesRun: [],
      },
    };

    await this.storeForRepo(repoRoot).add(session);
    return session;
  }

  async listSessions(repoPath?: string): Promise<SessionRecord[]> {
    const repoRoot = await this.resolveRepo(repoPath);
    return this.storeForRepo(repoRoot).list();
  }

  async getSession(input: SessionLookupInput): Promise<SessionRecord> {
    const repoRoot = await this.resolveRepo(input.repoPath);
    return this.storeForRepo(repoRoot).get(input.sessionId);
  }

  async cleanupSession(input: SessionLookupInput): Promise<SessionRecord> {
    const repoRoot = await this.resolveRepo(input.repoPath);
    const config = await loadConfig(repoRoot);
    const store = this.storeForRepo(repoRoot);
    const session = await store.get(input.sessionId);

    assertActiveSession(session, "cleanup_session");
    assertOwnedWorktreePath(repoRoot, session.worktreePath, config.worktreesRoot);
    await removeGitWorktree(repoRoot, session.worktreePath);

    return store.update(input.sessionId, (current) => ({
      ...current,
      status: "cleaned",
    }));
  }

  async gitStatus(input: SessionLookupInput): Promise<{ session: SessionRecord; status: string }> {
    const session = await this.getActiveSession(input, "git_status");
    const status = await gitStatusShort(session.worktreePath);
    const updated = await this.updateContract(input.repoPath, input.sessionId, (contract) => ({
      ...contract,
      lastStatusAt: new Date().toISOString(),
    }));

    return {
      session: updated,
      status,
    };
  }

  async gitDiff(input: SessionLookupInput): Promise<{ session: SessionRecord; diff: string }> {
    const session = await this.getActiveSession(input, "git_diff");
    const diff = await gitDiff(session.worktreePath);
    const updated = await this.updateContract(input.repoPath, input.sessionId, (contract) => ({
      ...contract,
      lastDiffAt: new Date().toISOString(),
    }));

    return {
      session: updated,
      diff,
    };
  }

  async readFile(input: SessionFileInput): Promise<{ session: SessionRecord; path: string; content: string }> {
    const session = await this.getActiveSession(input, "read_file");
    const target = await resolveExistingSessionPath(session.worktreePath, input.path);
    const path = toSessionRelativePath(session.worktreePath, target);
    const updated = await this.updateContract(input.repoPath, input.sessionId, (contract) => ({
      ...contract,
      readPaths: addUnique(contract.readPaths, path),
    }));

    return {
      session: updated,
      path,
      content: await readFile(target, "utf8"),
    };
  }

  async writeFile(input: SessionWriteFileInput): Promise<{ session: SessionRecord; path: string; bytesWritten: number }> {
    const session = await this.getActiveSession(input, "write_file");
    await this.assertExistingFileWasRead(session, input.path);
    const target = await resolveWritableSessionPath(session.worktreePath, input.path);
    const path = toSessionRelativePath(session.worktreePath, target);

    await writeFile(target, input.content, "utf8");
    const updated = await this.updateContract(input.repoPath, input.sessionId, (contract) => ({
      ...contract,
      writtenPaths: addUnique(contract.writtenPaths, path),
      lastMutationAt: new Date().toISOString(),
    }));

    return {
      session: updated,
      path,
      bytesWritten: Buffer.byteLength(input.content, "utf8"),
    };
  }

  async listFiles(input: SessionFileInput): Promise<{ session: SessionRecord; path: string; files: string[] }> {
    const session = await this.getActiveSession(input, "list_files");
    const target = await resolveExistingSessionPath(session.worktreePath, input.path);
    const files = await listRegularFiles(session.worktreePath, target);
    const path = toSessionRelativePath(session.worktreePath, target) || ".";
    const updated = await this.updateContract(input.repoPath, input.sessionId, (contract) => ({
      ...contract,
      listedPaths: addUnique(contract.listedPaths, path),
    }));

    return {
      session: updated,
      path,
      files,
    };
  }

  async runCommandProfile(input: RunCommandProfileInput): Promise<{ session: SessionRecord; result: CommandRunResult }> {
    const repoRoot = await this.resolveRepo(input.repoPath);
    const session = await this.storeForRepo(repoRoot).get(input.sessionId);
    assertActiveSession(session, "run_command_profile");
    const config = await loadConfig(repoRoot);
    const command = config.commands[input.profile];

    if (!command) {
      throw new UnknownCommandProfileError(input.profile);
    }

    const result = await executeCommandProfile(session.worktreePath, input.profile, command);
    const updated = await this.updateContract(input.repoPath, input.sessionId, (contract) => ({
      ...contract,
      commandProfilesRun: addUnique(contract.commandProfilesRun, input.profile),
      lastMutationAt: new Date().toISOString(),
    }));

    return {
      session: updated,
      result,
    };
  }

  async commitSession(input: CommitSessionInput): Promise<{ session: SessionRecord; commit: GitCommitResult; status: string }> {
    const session = await this.getActiveSession(input, "commit_session");
    const contractStatus = evaluateContract(session);

    if (!contractStatus.readyToCommit) {
      throw new Error(`Cannot commit session before contract review is complete. Required actions: ${contractStatus.requiredActions.join(", ")}`);
    }

    const commit = await commitAllChanges(session.worktreePath, input.message);

    return {
      session,
      commit,
      status: await gitStatusShort(session.worktreePath),
    };
  }

  async contractStatus(input: SessionLookupInput): Promise<ContractStatus> {
    const session = await this.getSession(input);
    return {
      session,
      ...evaluateContract(session),
    };
  }

  private async resolveRepo(repoPath = process.env.GROVEYARD_REPO ?? process.cwd()): Promise<string> {
    return resolveRepoRoot(resolve(repoPath));
  }

  private storeForRepo(repoRoot: string): JsonSessionStore {
    return new JsonSessionStore(join(repoRoot, metadataDirectory, "sessions.json"));
  }

  private async getActiveSession(input: SessionLookupInput, toolName: string): Promise<SessionRecord> {
    const session = await this.getSession(input);
    assertActiveSession(session, toolName);
    return session;
  }

  private async updateContract(
    repoPath: string | undefined,
    sessionId: string,
    update: (contract: SessionRecord["contract"]) => SessionRecord["contract"],
  ): Promise<SessionRecord> {
    const repoRoot = await this.resolveRepo(repoPath);
    return this.storeForRepo(repoRoot).update(sessionId, (current) => ({
      ...current,
      contract: update(current.contract),
    }));
  }

  private async assertExistingFileWasRead(session: SessionRecord, userPath: string): Promise<void> {
    try {
      const existingTarget = await resolveExistingSessionPath(session.worktreePath, userPath);
      const path = toSessionRelativePath(session.worktreePath, existingTarget);

      if (!session.contract.readPaths.includes(path)) {
        throw new Error(`Contract violation: read_file must be called for "${path}" before write_file can overwrite it.`);
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }

      throw error;
    }
  }
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return slug || "task";
}

export function assertOwnedWorktreePath(repoRoot: string, worktreePath: string, worktreesRoot = ".agent-worktrees"): void {
  const root = resolve(repoRoot, worktreesRoot);
  const target = resolve(worktreePath);

  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`Refusing to clean up unowned worktree path: ${worktreePath}`);
  }
}

export function assertActiveSession(session: SessionRecord, toolName: string): void {
  if (session.status !== "active") {
    throw new Error(`Contract violation: ${toolName} requires an active session, but ${session.id} is ${session.status}.`);
  }
}

export function evaluateContract(session: SessionRecord): Omit<ContractStatus, "session"> {
  const activeSession = session.status === "active";
  const lastMutationAt = session.contract.lastMutationAt;
  const statusReviewedAfterLatestMutation = !lastMutationAt || isAtOrAfter(session.contract.lastStatusAt, lastMutationAt);
  const diffReviewedAfterLatestMutation = !lastMutationAt || isAtOrAfter(session.contract.lastDiffAt, lastMutationAt);
  const requiredActions: string[] = [];

  if (!activeSession) {
    requiredActions.push("create or select an active session");
  }

  if (!statusReviewedAfterLatestMutation) {
    requiredActions.push("call git_status after the latest write or command");
  }

  if (!diffReviewedAfterLatestMutation) {
    requiredActions.push("call git_diff after the latest write or command");
  }

  return {
    readyToCommit: activeSession && statusReviewedAfterLatestMutation && diffReviewedAfterLatestMutation,
    checks: {
      activeSession,
      statusReviewedAfterLatestMutation,
      diffReviewedAfterLatestMutation,
    },
    requiredActions,
  };
}

function createSessionId(): string {
  return `sess_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

function addUnique(values: string[], value: string): string[] {
  return values.includes(value) ? values : [...values, value];
}

function isAtOrAfter(value: string | undefined, baseline: string): boolean {
  return Boolean(value && value >= baseline);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function listRegularFiles(worktreePath: string, directoryPath: string, limit = 1000): Promise<string[]> {
  const files: string[] = [];
  await walk(directoryPath);
  return files.sort();

  async function walk(currentDirectory: string): Promise<void> {
    if (files.length >= limit) {
      return;
    }

    const entries = await readdir(currentDirectory, { withFileTypes: true });

    for (const entry of entries) {
      if (files.length >= limit) {
        return;
      }

      if (entry.name === ".git") {
        continue;
      }

      const entryPath = join(currentDirectory, entry.name);
      const stats = await lstat(entryPath);

      if (stats.isSymbolicLink()) {
        continue;
      }

      if (stats.isDirectory()) {
        await walk(entryPath);
        continue;
      }

      if (stats.isFile()) {
        files.push(toSessionRelativePath(worktreePath, entryPath));
      }
    }
  }
}
