import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import {
  assertCleanWorktree,
  createGitWorktree,
  getCurrentBranch,
  gitDiff,
  gitStatusShort,
  removeGitWorktree,
  resolveRepoRoot,
} from "./git.js";
import { JsonSessionStore } from "./session-store.js";
import type { SessionRecord } from "./sessions.js";

const metadataDirectory = ".worktree-mcp";
const defaultWorktreesRoot = ".agent-worktrees";
const defaultBranchPrefix = "agent/";

export type CreateSessionInput = {
  repoPath?: string;
  taskName: string;
  baseBranch?: string;
};

export type SessionLookupInput = {
  repoPath?: string;
  sessionId: string;
};

export class WorktreeSessionService {
  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const repoRoot = await this.resolveRepo(input.repoPath);
    await assertCleanWorktree(repoRoot);

    const taskSlug = slugify(input.taskName);
    const id = createSessionId();
    const suffix = id.replace(/^sess_/, "");
    const baseBranch = input.baseBranch ?? (await getCurrentBranch(repoRoot));
    const branch = `${defaultBranchPrefix}${taskSlug}-${suffix}`;
    const worktreePath = join(repoRoot, defaultWorktreesRoot, id);
    const now = new Date().toISOString();

    await mkdir(join(repoRoot, defaultWorktreesRoot), { recursive: true });
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
    const store = this.storeForRepo(repoRoot);
    const session = await store.get(input.sessionId);

    assertOwnedWorktreePath(repoRoot, session.worktreePath);
    await removeGitWorktree(repoRoot, session.worktreePath);

    return store.update(input.sessionId, (current) => ({
      ...current,
      status: "cleaned",
    }));
  }

  async gitStatus(input: SessionLookupInput): Promise<{ session: SessionRecord; status: string }> {
    const session = await this.getSession(input);
    return {
      session,
      status: await gitStatusShort(session.worktreePath),
    };
  }

  async gitDiff(input: SessionLookupInput): Promise<{ session: SessionRecord; diff: string }> {
    const session = await this.getSession(input);
    return {
      session,
      diff: await gitDiff(session.worktreePath),
    };
  }

  private async resolveRepo(repoPath = process.cwd()): Promise<string> {
    return resolveRepoRoot(resolve(repoPath));
  }

  private storeForRepo(repoRoot: string): JsonSessionStore {
    return new JsonSessionStore(join(repoRoot, metadataDirectory, "sessions.json"));
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

export function assertOwnedWorktreePath(repoRoot: string, worktreePath: string): void {
  const root = resolve(repoRoot, defaultWorktreesRoot);
  const target = resolve(worktreePath);

  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`Refusing to clean up unowned worktree path: ${worktreePath}`);
  }
}

function createSessionId(): string {
  return `sess_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}
