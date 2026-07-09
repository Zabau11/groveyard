import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";

import { WorktreeSessionService, assertOwnedWorktreePath, slugify } from "./lifecycle.js";
import { JsonSessionStore } from "./session-store.js";
import type { SessionRecord } from "./sessions.js";

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

  const read = await service.readFile({ repoPath: repo, sessionId: created.id, path: "changed.txt" });
  assert.equal(read.content, "changed\n");
  assert.equal(read.path, "changed.txt");

  const written = await service.writeFile({
    repoPath: repo,
    sessionId: created.id,
    path: "src/new-file.txt",
    content: "new file\n",
  });
  assert.equal(written.path, "src/new-file.txt");
  assert.equal(written.bytesWritten, 9);

  const files = await service.listFiles({ repoPath: repo, sessionId: created.id, path: "." });
  assert.deepEqual(files.files, ["README.md", "changed.txt", "src/new-file.txt"]);

  await writeFile(
    join(repo, ".groveyard.yml"),
    `commands:
  echo: node scripts/echo.mjs
  fail: node scripts/fail.mjs
`,
    "utf8",
  );
  await mkdir(join(created.worktreePath, "scripts"), { recursive: true });
  await writeFile(join(created.worktreePath, "scripts/echo.mjs"), "console.log('hello from profile');\n", "utf8");
  await writeFile(join(created.worktreePath, "scripts/fail.mjs"), "process.exit(7);\n", "utf8");
  const command = await service.runCommandProfile({ repoPath: repo, sessionId: created.id, profile: "echo" });
  assert.equal(command.result.exitCode, 0);
  assert.equal(command.result.stdout.trim(), "hello from profile");

  const failedCommand = await service.runCommandProfile({ repoPath: repo, sessionId: created.id, profile: "fail" });
  assert.equal(failedCommand.result.exitCode, 7);

  await assert.rejects(
    () => service.runCommandProfile({ repoPath: repo, sessionId: created.id, profile: "missing" }),
    /Unknown command profile/,
  );

  const status = await service.gitStatus({ repoPath: repo, sessionId: created.id });
  assert.match(status.status, /\?\? changed\.txt/);

  await writeFile(join(created.worktreePath, "README.md"), "# Updated\n", "utf8");
  const diff = await service.gitDiff({ repoPath: repo, sessionId: created.id });
  assert.match(diff.diff, /diff --git a\/README\.md b\/README\.md/);
  assert.match(diff.diff, /# Updated/);
  assert.match(diff.diff, /diff --git a\/src\/new-file\.txt b\/src\/new-file\.txt/);
  assert.match(diff.diff, /new file/);
  const reviewedStatus = await service.gitStatus({ repoPath: repo, sessionId: created.id });
  assert.match(reviewedStatus.status, /M README\.md/);

  const contract = await service.contractStatus({ repoPath: repo, sessionId: created.id });
  assert.equal(contract.readyToCommit, true);

  const committed = await service.commitSession({
    repoPath: repo,
    sessionId: created.id,
    message: "Commit session changes",
  });
  assert.match(committed.commit.sha, /^[a-f0-9]{40}$/);
  assert.equal(committed.commit.message, "Commit session changes");
  assert.equal(committed.status, "");

  await assert.rejects(
    () => service.commitSession({ repoPath: repo, sessionId: created.id, message: "Empty commit" }),
    /requires an active session/,
  );

  const cleaned = await service.cleanupSession({ repoPath: repo, sessionId: created.id });
  assert.equal(cleaned.status, "cleaned");
});

test("WorktreeSessionService reconciles clean committed sessions from git state", async () => {
  const repo = await createRepo();
  const service = new WorktreeSessionService();
  const created = await service.createSession({
    repoPath: repo,
    taskName: "Committed session",
    baseBranch: "main",
  });

  await service.readFile({ repoPath: repo, sessionId: created.id, path: "README.md" });
  await service.writeFile({
    repoPath: repo,
    sessionId: created.id,
    path: "README.md",
    content: "# Committed\n",
  });
  await service.gitStatus({ repoPath: repo, sessionId: created.id });
  await service.gitDiff({ repoPath: repo, sessionId: created.id });
  await service.commitSession({
    repoPath: repo,
    sessionId: created.id,
    message: "Commit session changes",
  });

  const completed = await service.listSessions(repo);
  assert.equal(completed[0]?.status, "completed");

  const status = await service.gitStatus({ repoPath: repo, sessionId: created.id });
  assert.equal(status.status, "");

  const cleaned = await service.cleanupSession({ repoPath: repo, sessionId: created.id });
  assert.equal(cleaned.status, "cleaned");
});

test("WorktreeSessionService auto-cleans sessions merged into target branches", async () => {
  const repo = await createRepo();
  const service = new WorktreeSessionService();
  const created = await service.createSession({
    repoPath: repo,
    taskName: "Merged session",
    baseBranch: "main",
  });

  await service.readFile({ repoPath: repo, sessionId: created.id, path: "README.md" });
  await service.writeFile({
    repoPath: repo,
    sessionId: created.id,
    path: "README.md",
    content: "# Merged\n",
  });
  await service.gitStatus({ repoPath: repo, sessionId: created.id });
  await service.gitDiff({ repoPath: repo, sessionId: created.id });
  await service.commitSession({
    repoPath: repo,
    sessionId: created.id,
    message: "Commit merged session",
  });
  await git(repo, ["merge", "--ff-only", created.branch]);

  const reconciled = await service.listSessions(repo);
  assert.equal(reconciled[0]?.status, "cleaned");
});

test("WorktreeSessionService enforces read-before-overwrite and review-before-commit", async () => {
  const repo = await createRepo();
  const service = new WorktreeSessionService();
  const created = await service.createSession({
    repoPath: repo,
    taskName: "Enforce contract",
    baseBranch: "main",
  });

  await assert.rejects(
    () =>
      service.writeFile({
        repoPath: repo,
        sessionId: created.id,
        path: "README.md",
        content: "# Overwrite\n",
      }),
    /read_file must be called/,
  );

  await service.readFile({ repoPath: repo, sessionId: created.id, path: "README.md" });
  await service.writeFile({
    repoPath: repo,
    sessionId: created.id,
    path: "README.md",
    content: "# Overwrite\n",
  });

  const needsReview = await service.contractStatus({ repoPath: repo, sessionId: created.id });
  assert.equal(needsReview.readyToCommit, false);
  assert.deepEqual(needsReview.requiredActions, ["call git_status after the latest write or command", "call git_diff after the latest write or command"]);

  await assert.rejects(
    () =>
      service.commitSession({
        repoPath: repo,
        sessionId: created.id,
        message: "Should not commit",
      }),
    /contract review is complete/,
  );

  await service.gitStatus({ repoPath: repo, sessionId: created.id });
  await service.gitDiff({ repoPath: repo, sessionId: created.id });

  const ready = await service.contractStatus({ repoPath: repo, sessionId: created.id });
  assert.equal(ready.readyToCommit, true);

  await service.cleanupSession({ repoPath: repo, sessionId: created.id });
});

test("WorktreeSessionService rejects active operations after cleanup", async () => {
  const repo = await createRepo();
  const service = new WorktreeSessionService();
  const created = await service.createSession({
    repoPath: repo,
    taskName: "Cleanup contract",
    baseBranch: "main",
  });

  await service.cleanupSession({ repoPath: repo, sessionId: created.id });

  await assert.rejects(
    () => service.gitStatus({ repoPath: repo, sessionId: created.id }),
    /requires an available worktree/,
  );
});

test("WorktreeSessionService rejects path escape attempts", async () => {
  const repo = await createRepo();
  const outside = await mkdtemp(join(tmpdir(), "groveyard-outside-"));
  const service = new WorktreeSessionService();
  const created = await service.createSession({
    repoPath: repo,
    taskName: "Path safety",
    baseBranch: "main",
  });

  await writeFile(join(outside, "secret.txt"), "secret\n", "utf8");
  await symlink(join(outside, "secret.txt"), join(created.worktreePath, "secret-link.txt"));

  await assert.rejects(
    () => service.readFile({ repoPath: repo, sessionId: created.id, path: "../README.md" }),
    /escapes the session worktree/,
  );
  await assert.rejects(
    () => service.readFile({ repoPath: repo, sessionId: created.id, path: join(outside, "secret.txt") }),
    /Absolute paths are not allowed/,
  );
  await assert.rejects(
    () => service.readFile({ repoPath: repo, sessionId: created.id, path: "secret-link.txt" }),
    /escapes the session worktree/,
  );
  await assert.rejects(
    () => service.writeFile({ repoPath: repo, sessionId: created.id, path: "secret-link.txt", content: "overwrite\n" }),
    /escapes the session worktree/,
  );
  await symlink(outside, join(created.worktreePath, "outside-dir"));
  await assert.rejects(
    () => service.writeFile({ repoPath: repo, sessionId: created.id, path: "outside-dir/new.txt", content: "overwrite\n" }),
    /escapes the session worktree/,
  );

  const files = await service.listFiles({ repoPath: repo, sessionId: created.id, path: "." });
  assert.ok(!files.files.includes("secret-link.txt"));
  assert.ok(!files.files.some((file) => file.startsWith("outside-dir/")));

  await service.cleanupSession({ repoPath: repo, sessionId: created.id });
});

test("WorktreeSessionService refuses cleanup for forged unowned session paths", async () => {
  const repo = await createRepo();
  const outside = await mkdtemp(join(tmpdir(), "groveyard-outside-"));
  const session = exampleSession({
    repoPath: repo,
    worktreePath: outside,
  });
  const store = new JsonSessionStore(join(repo, ".groveyard", "sessions.json"));
  const service = new WorktreeSessionService();

  await store.add(session);

  await assert.rejects(
    () => service.cleanupSession({ repoPath: repo, sessionId: session.id }),
    /Refusing to clean up unowned worktree path/,
  );
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

test("WorktreeSessionService explains repoPath filesystem mismatches", async () => {
  const service = new WorktreeSessionService();

  await assert.rejects(
    () => service.listSessions("/tmp/groveyard-missing-repo"),
    /repoPath is resolved on the MCP server process filesystem/,
  );
});

test("WorktreeSessionService honors worktree root, branch prefix, and dirty-base config", async () => {
  const repo = await createRepo();
  const service = new WorktreeSessionService();

  await writeFile(
    join(repo, ".groveyard.yml"),
    `worktreesRoot: .custom-worktrees
branchPrefix: codex/
allowDirtyBase: true
`,
    "utf8",
  );
  await writeFile(join(repo, "dirty.txt"), "dirty\n", "utf8");

  const created = await service.createSession({
    repoPath: repo,
    taskName: "Configured session",
    baseBranch: "main",
  });

  assert.match(created.worktreePath, /\.custom-worktrees\/sess_/);
  assert.match(created.branch, /^codex\/configured-session-/);

  const cleaned = await service.cleanupSession({ repoPath: repo, sessionId: created.id });
  assert.equal(cleaned.status, "cleaned");
});

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "groveyard-repo-"));

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

function exampleSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "sess_forged",
    repoPath: "/repo",
    worktreePath: "/repo/.agent-worktrees/sess_forged",
    branch: "agent/forged",
    baseBranch: "main",
    baseCommit: "abc123",
    taskName: "forged",
    status: "active",
    createdAt: "2026-07-07T12:00:00.000Z",
    updatedAt: "2026-07-07T12:00:00.000Z",
    contract: {
      readPaths: [],
      listedPaths: [],
      writtenPaths: [],
      commandProfilesRun: [],
    },
    ...overrides,
  };
}
