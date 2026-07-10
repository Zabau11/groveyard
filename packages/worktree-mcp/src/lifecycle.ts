import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import {
  assertCleanWorktree,
  branchHasCommitsAfter,
  branchHasUniqueCommits,
  gitRefExists,
  type GitCommitResult,
  commitAllChanges,
  createGitWorktree,
  getCurrentBranch,
  getRefSha,
  gitDiff,
  gitStatusShort,
  isBranchMergedInto,
  isWorktreeClean,
  removeGitWorktree,
  resolveWorktreeGroup,
} from "./git.js";
import { JsonSessionStore } from "./session-store.js";
import { newSessionContract, type SessionRecord } from "./sessions.js";
import { resolveExistingSessionPath, resolveWritableSessionPath, toSessionRelativePath } from "./path-safety.js";
import { loadConfig } from "./config.js";
import {
  type CommandRunResult,
  UnknownCommandProfileError,
  runCommandProfile as executeCommandProfile,
} from "./command-runner.js";
import { terminateProcessesInWorktree } from "./process-cleanup.js";

const metadataDirectory = ".groveyard";

export type CreateSessionInput = {
  repoPath?: string;
  taskName: string;
  baseBranch?: string;
};

export type StartSessionInput = CreateSessionInput & {
  workspacePath?: string;
};

export type StartSessionResult = {
  session: SessionRecord;
  action: "created" | "adopted" | "reused";
};

export type ResumeSessionResult = {
  session: SessionRecord;
  action: "resumed" | "already_active";
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
    return (await this.startSession(input, true)).session;
  }

  async startSession(input: StartSessionInput, forceManaged = false): Promise<StartSessionResult> {
    const configuredGroup = await resolveWorktreeGroup(resolve(input.repoPath ?? process.env.GROVEYARD_REPO ?? process.cwd()));
    const repoRoot = configuredGroup.primaryPath;
    let workspace = configuredGroup.current;

    if (!forceManaged && input.workspacePath) {
      const requestedWorkspace = await realpath(resolve(input.workspacePath));
      const config = await loadConfig(repoRoot);
      const managedRoot = resolve(repoRoot, config.worktreesRoot);
      if (
        (requestedWorkspace === managedRoot || requestedWorkspace.startsWith(`${managedRoot}${sep}`)) &&
        !configuredGroup.worktrees.some((record) => requestedWorkspace === record.path || requestedWorkspace.startsWith(`${record.path}${sep}`))
      ) {
        throw new Error(`Refusing to adopt ${requestedWorkspace} because it is under Groveyard's managed workspace root but is not a registered Git worktree. Repair or remove the orphan explicitly.`);
      }
      const workspaceGroup = await resolveWorktreeGroup(resolve(input.workspacePath));
      if (workspaceGroup.commonGitDirectory !== configuredGroup.commonGitDirectory) {
        throw new Error("workspacePath belongs to a different Git repository.");
      }
      workspace = workspaceGroup.current;
    } else if (!forceManaged && !input.workspacePath) {
      try {
        const cwdGroup = await resolveWorktreeGroup(process.cwd());
        if (cwdGroup.commonGitDirectory === configuredGroup.commonGitDirectory) workspace = cwdGroup.current;
        else workspace = configuredGroup.worktrees.find((item) => item.primary)!;
      } catch {
        workspace = configuredGroup.worktrees.find((item) => item.primary)!;
      }
    } else {
      workspace = configuredGroup.worktrees.find((item) => item.primary)!;
    }

    if (workspace.detached || !workspace.branch) throw new Error(`Cannot start a session from detached-HEAD worktree ${workspace.path}. Check out a named branch first.`);

    if (!workspace.primary) {
      return this.adoptSession(repoRoot, workspace.path, workspace.branch, workspace.head, input);
    }

    const session = await this.createManagedSession(repoRoot, input);
    return { session, action: "created" };
  }

  private async createManagedSession(repoRoot: string, input: CreateSessionInput): Promise<SessionRecord> {
    const config = await loadConfig(repoRoot);

    if (!config.allowDirtyBase) {
      await assertCleanWorktree(repoRoot);
    }

    const taskSlug = slugify(input.taskName);
    const id = createSessionId();
    const suffix = id.replace(/^sess_/, "");
    const baseBranch = input.baseBranch ?? (await getCurrentBranch(repoRoot));
    const baseCommit = await getRefSha(repoRoot, baseBranch);
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
      baseCommit,
      taskName: input.taskName,
      origin: "managed",
      status: "active",
      createdAt: now,
      updatedAt: now,
      contract: newSessionContract(),
    };

    await this.storeForRepo(repoRoot).add(session);
    return session;
  }

  private async adoptSession(
    repoRoot: string,
    worktreePath: string,
    branch: string,
    head: string,
    input: StartSessionInput,
  ): Promise<StartSessionResult> {
    const store = this.storeForRepo(repoRoot);
    const sessions = await store.list();
    const samePath = sessions.filter((session) => resolve(session.worktreePath) === resolve(worktreePath));
    const active = samePath.find((session) => session.status === "active");
    if (active) return { session: active, action: "reused" };
    if (samePath.some((session) => session.status === "completed")) {
      throw new Error(`A completed Groveyard session already references ${worktreePath}. Release or clean that session before reusing the workspace.`);
    }

    const config = await loadConfig(repoRoot);
    const managedRoot = resolve(repoRoot, config.worktreesRoot);
    const canonicalPath = resolve(worktreePath);
    if (canonicalPath === managedRoot || canonicalPath.startsWith(`${managedRoot}${sep}`)) {
      throw new Error(`Refusing to adopt ${worktreePath} because it is under Groveyard's managed workspace root and may be an orphaned managed worktree.`);
    }

    const now = new Date().toISOString();
    const session: SessionRecord = {
      id: createSessionId(),
      repoPath: repoRoot,
      worktreePath,
      branch,
      baseBranch: input.baseBranch ?? branch,
      baseCommit: head,
      taskName: input.taskName,
      origin: "adopted",
      status: "active",
      createdAt: now,
      updatedAt: now,
      contract: newSessionContract(),
    };
    await store.add(session);
    return { session, action: "adopted" };
  }

  async listSessions(repoPath?: string): Promise<SessionRecord[]> {
    const repoRoot = await this.resolveRepo(repoPath);
    await this.reconcileSessions(repoRoot);
    return this.storeForRepo(repoRoot).list();
  }

  async getSession(input: SessionLookupInput): Promise<SessionRecord> {
    const repoRoot = await this.resolveRepo(input.repoPath);
    await this.reconcileSessions(repoRoot);
    return this.storeForRepo(repoRoot).get(input.sessionId);
  }

  async resumeSession(input: SessionLookupInput): Promise<ResumeSessionResult> {
    const repoRoot = await this.resolveRepo(input.repoPath);
    await this.reconcileSessions(repoRoot);
    const store = this.storeForRepo(repoRoot);
    const session = await store.get(input.sessionId);

    if (session.status === "active") {
      return { session, action: "already_active" };
    }

    if (session.status === "cleaned" || session.status === "released" || session.status === "failed") {
      throw new Error(`Cannot resume ${session.id} because it is ${session.status}. Start a new session if more work is needed.`);
    }

    if (session.status !== "completed") {
      throw new Error(`Cannot resume ${session.id} because it is ${session.status}.`);
    }

    if (!(await pathExists(session.worktreePath))) {
      throw new Error(`Cannot resume ${session.id} because its workspace no longer exists at ${session.worktreePath}.`);
    }

    const worktreeGroup = await resolveWorktreeGroup(session.worktreePath);
    const normalizedWorktreePath = resolve(session.worktreePath);
    if (!worktreeGroup.worktrees.some((record) => record.path === normalizedWorktreePath)) {
      throw new Error(`Cannot resume ${session.id} because ${session.worktreePath} is not a registered Git worktree.`);
    }

    if (!(await gitRefExists(repoRoot, session.branch))) {
      throw new Error(`Cannot resume ${session.id} because branch ${session.branch} no longer exists.`);
    }

    if (!(await isWorktreeClean(session.worktreePath))) {
      throw new Error(`Cannot resume ${session.id} because ${session.worktreePath} has uncommitted changes.`);
    }

    const config = await loadConfig(repoRoot);
    for (const targetBranch of config.autoCleanBranches) {
      if (await isBranchMergedInto(repoRoot, session.branch, targetBranch)) {
        throw new Error(`Cannot resume ${session.id} because branch ${session.branch} is already merged into ${targetBranch}.`);
      }
    }

    const resumed = await store.update(input.sessionId, (current) => ({
      ...current,
      status: "active",
      contract: {
        ...newSessionContract(),
        resumedAt: new Date().toISOString(),
      },
    }));
    return { session: resumed, action: "resumed" };
  }

  async cleanupSession(input: SessionLookupInput): Promise<SessionRecord> {
    const repoRoot = await this.resolveRepo(input.repoPath);
    const config = await loadConfig(repoRoot);
    const store = this.storeForRepo(repoRoot);
    const session = await store.get(input.sessionId);

    assertCleanableSession(session, "cleanup_session");
    if (session.origin === "adopted") {
      return store.update(input.sessionId, (current) => ({
        ...current,
        status: "released",
      }));
    }
    assertOwnedWorktreePath(repoRoot, session.worktreePath, config.worktreesRoot);
    await terminateProcessesInWorktree(session.worktreePath);
    await removeGitWorktree(repoRoot, session.worktreePath);

    return store.update(input.sessionId, (current) => ({
      ...current,
      status: "cleaned",
    }));
  }

  async gitStatus(input: SessionLookupInput): Promise<{ session: SessionRecord; status: string }> {
    const session = await this.getSession(input);
    assertWorktreeAvailable(session, "git_status");
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
    const session = await this.getSession(input);
    assertWorktreeAvailable(session, "git_diff");
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
      resumedAt: undefined,
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
      resumedAt: undefined,
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
    const status = await gitStatusShort(session.worktreePath);
    const completedSession = status
      ? session
      : await this.completeSession(input.repoPath, input.sessionId, session.worktreePath);

    return {
      session: completedSession,
      commit,
      status,
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
    return (await resolveWorktreeGroup(resolve(repoPath))).primaryPath;
  }

  private storeForRepo(repoRoot: string): JsonSessionStore {
    return new JsonSessionStore(join(repoRoot, metadataDirectory, "sessions.json"));
  }

  private async reconcileSessions(repoRoot: string): Promise<void> {
    const store = this.storeForRepo(repoRoot);
    const [config, sessions] = await Promise.all([loadConfig(repoRoot), store.list()]);

    for (const session of sessions) {
      if (
        session.origin === "adopted" &&
        (session.status === "active" || session.status === "completed") &&
        !(await pathExists(session.worktreePath))
      ) {
        await store.update(session.id, (current) => ({ ...current, status: "released" }));
        continue;
      }

      if (session.status === "completed" && (await shouldAutoCleanCompletedSession(repoRoot, session, config.autoCleanBranches))) {
        if (session.origin === "managed") {
          await terminateProcessesInWorktree(session.worktreePath);
          await removeGitWorktree(repoRoot, session.worktreePath);
        }
        await store.update(session.id, (current) => ({
          ...current,
          status: session.origin === "managed" ? "cleaned" : "released",
        }));
        continue;
      }

      if (session.status !== "active") {
        continue;
      }

      const nextStatus = await reconcileSessionStatus(repoRoot, session, config.autoCleanBranches);

      if (nextStatus === session.status) {
        continue;
      }

      await store.update(session.id, (current) => ({
        ...current,
        status: nextStatus,
      }));
    }
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

  private async completeSession(repoPath: string | undefined, sessionId: string, worktreePath: string): Promise<SessionRecord> {
    const repoRoot = await this.resolveRepo(repoPath);
    const current = await this.storeForRepo(repoRoot).get(sessionId);
    if (current.origin === "managed") await terminateProcessesInWorktree(worktreePath);

    return this.storeForRepo(repoRoot).update(sessionId, (current) => ({
      ...current,
      status: "completed",
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

async function reconcileSessionStatus(repoRoot: string, session: SessionRecord, autoCleanBranches: string[]): Promise<SessionRecord["status"]> {
  if (!(await pathExists(session.worktreePath))) {
    return session.origin === "adopted" ? "released" : session.status;
  }

  if (session.origin === "adopted" && session.baseCommit && (await branchHasCommitsAfter(repoRoot, session.baseCommit, session.branch))) {
    for (const targetBranch of autoCleanBranches) {
      if (await isBranchMergedInto(repoRoot, session.branch, targetBranch)) return "released";
    }
  }

  if (!(await isWorktreeClean(session.worktreePath))) {
    return "active";
  }

  if (session.contract.resumedAt && !isAtOrAfter(session.contract.lastMutationAt, session.contract.resumedAt)) {
    return "active";
  }

  if (!session.baseCommit) {
    for (const targetBranch of autoCleanBranches) {
      if (await isBranchMergedInto(repoRoot, session.branch, targetBranch)) {
        if (session.origin === "managed") {
          await terminateProcessesInWorktree(session.worktreePath);
          await removeGitWorktree(repoRoot, session.worktreePath);
          return "cleaned";
        }
        return "released";
      }
    }

    if (await branchHasUniqueCommits(repoRoot, session.baseBranch, session.branch)) {
      if (session.origin === "managed") await terminateProcessesInWorktree(session.worktreePath);
      return "completed";
    }

    return "active";
  }

  if (!(await branchHasCommitsAfter(repoRoot, session.baseCommit, session.branch))) {
    return "active";
  }

  for (const targetBranch of autoCleanBranches) {
    if (await isBranchMergedInto(repoRoot, session.branch, targetBranch)) {
      if (session.origin === "managed") {
        await terminateProcessesInWorktree(session.worktreePath);
        await removeGitWorktree(repoRoot, session.worktreePath);
        return "cleaned";
      }
      return "released";
    }
  }

  if (session.origin === "managed") await terminateProcessesInWorktree(session.worktreePath);
  return "completed";
}

async function shouldAutoCleanCompletedSession(repoRoot: string, session: SessionRecord, autoCleanBranches: string[]): Promise<boolean> {
  for (const targetBranch of autoCleanBranches) {
    if (await isBranchMergedInto(repoRoot, session.branch, targetBranch)) {
      return true;
    }
  }

  return false;
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

export function assertWorktreeAvailable(session: SessionRecord, toolName: string): void {
  if (session.status === "cleaned" || session.status === "released") {
    throw new Error(`Contract violation: ${toolName} requires an available worktree, but ${session.id} is ${session.status}.`);
  }
}

export function assertCleanableSession(session: SessionRecord, toolName: string): void {
  if (session.status !== "active" && session.status !== "completed") {
    throw new Error(`Contract violation: ${toolName} requires an active or completed session, but ${session.id} is ${session.status}.`);
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
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
