import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";

import { WorktreeSessionService, assertOwnedWorktreePath, slugify } from "./lifecycle.js";

const execFileAsync = promisify(execFile);

test("slugify creates branch-safe slugs", () => {
  assert.equal(slugify("Fix checkout button!"), "fix-checkout-button");
  assert.equal(slugify("!!!"), "task");
});

test("assertOwnedWorktreePath rejects paths outside the managed root", () => {
  assert.doesNotThrow(() => assertOwnedWorktreePath("/repo", "/repo/.agent-worktrees/sess_1"));
  assert.throws(() => assertOwnedWorktreePath("/repo", "/repo/other/sess_1"));
});

test("WorktreeSessionService creates, lists, gets, and cleans a session", async () => {
  const repo = await createRepo();
  const service = new WorktreeSessionService();

  const created = await service.createSession({
    repoPath: repo,
    taskName: "Fix checkout button",
    baseBranch: "main",
  });

  assert.equal(created.repoPath, repo);
  assert.equal(created.baseBranch, "main");
  assert.equal(created.status, "active");
  assert.match(created.branch, /^agent\/fix-checkout-button-/);

  const listed = await service.listSessions(repo);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, created.id);

  const fetched = await service.getSession({ repoPath: repo, sessionId: created.id });
  assert.equal(fetched.worktreePath, created.worktreePath);

  await writeFile(join(created.worktreePath, "changed.txt"), "changed\n", "utf8");
  const changed = await readFile(join(created.worktreePath, "changed.txt"), "utf8");
  assert.equal(changed, "changed\n");

  const cleaned = await service.cleanupSession({ repoPath: repo, sessionId: created.id });
  assert.equal(cleaned.status, "cleaned");
});

test("WorktreeSessionService rejects dirty base repositories", async () => {
  const repo = await createRepo();
  const service = new WorktreeSessionService();

  await writeFile(join(repo, "dirty.txt"), "dirty\n", "utf8");

  await assert.rejects(
    () =>
      service.createSession({
        repoPath: repo,
        taskName: "Dirty task",
        baseBranch: "main",
      }),
    /uncommitted changes/,
  );
});

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "worktree-mcp-repo-"));

  await git(repo, ["init", "-b", "main"]);
  await writeFile(join(repo, "README.md"), "# Test\n", "utf8");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "Initial commit"]);

  return realpath(repo);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}
