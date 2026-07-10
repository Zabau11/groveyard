import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
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
  assert.equal(committed.session.status, "completed");

  await assert.rejects(
    () => service.commitSession({ repoPath: repo, sessionId: created.id, message: "Empty commit" }),
    /requires an active session/,
  );

  const cleaned = await service.cleanupSession({ repoPath: repo, sessionId: created.id });
  assert.equal(cleaned.status, "cleaned");
});

test("startSession creates a managed workspace from the primary checkout", async () => {
  const repo = await createRepo();
  const service = new WorktreeSessionService();
  const result = await service.startSession({ repoPath: repo, workspacePath: repo, taskName: "Managed start" });

  assert.equal(result.action, "created");
  assert.equal(result.session.origin, "managed");
  assert.notEqual(result.session.worktreePath, repo);
  assert.match(result.session.worktreePath, /\.agent-worktrees/);
  await service.cleanupSession({ repoPath: repo, sessionId: result.session.id });
});

test("startSession adopts a linked worktree and reuses its active session", async () => {
  const repo = await createRepo();
  const linked = await mkdtemp(join(tmpdir(), "groveyard-native-worktree-"));
  await git(repo, ["worktree", "add", "-b", "native/auth-fix", linked, "main"]);
  await mkdir(join(linked, "src"), { recursive: true });
  await writeFile(join(linked, "src", "dirty.txt"), "uncommitted\n", "utf8");
  const head = (await git(linked, ["rev-parse", "HEAD"])).trim();
  const service = new WorktreeSessionService();

  const adopted = await service.startSession({
    repoPath: repo,
    workspacePath: join(linked, "src"),
    taskName: "Adopt auth fix",
  });

  assert.equal(adopted.action, "adopted");
  assert.equal(adopted.session.origin, "adopted");
  assert.equal(adopted.session.worktreePath, await realpath(linked));
  assert.equal(adopted.session.branch, "native/auth-fix");
  assert.equal(adopted.session.baseBranch, "native/auth-fix");
  assert.equal(adopted.session.baseCommit, head);

  const status = await service.gitStatus({ repoPath: linked, sessionId: adopted.session.id });
  assert.match(status.status, /src\//);
  const reused = await service.startSession({ repoPath: linked, workspacePath: linked, taskName: "Same workspace" });
  assert.equal(reused.action, "reused");
  assert.equal(reused.session.id, adopted.session.id);

  const primarySessions = await service.listSessions(repo);
  const linkedSessions = await service.listSessions(linked);
  assert.equal(primarySessions[0]?.id, linkedSessions[0]?.id);
});

test("cleanup releases an adopted worktree without removing files or the branch", async () => {
  const repo = await createRepo();
  const linked = await mkdtemp(join(tmpdir(), "groveyard-release-worktree-"));
  await git(repo, ["worktree", "add", "-b", "native/release", linked, "main"]);
  await writeFile(join(linked, "keep.txt"), "keep\n", "utf8");
  const service = new WorktreeSessionService();
  const adopted = await service.startSession({ repoPath: repo, workspacePath: linked, taskName: "Release safely" });

  const released = await service.cleanupSession({ repoPath: repo, sessionId: adopted.session.id });
  assert.equal(released.status, "released");
  assert.equal(await readFile(join(linked, "keep.txt"), "utf8"), "keep\n");
  assert.equal((await git(repo, ["branch", "--list", "native/release"])).trim().length > 0, true);

  await assert.rejects(() => service.gitStatus({ repoPath: repo, sessionId: released.id }), /released/);
  const readopted = await service.startSession({ repoPath: repo, workspacePath: linked, taskName: "Adopt again" });
  assert.equal(readopted.action, "adopted");
  assert.notEqual(readopted.session.id, released.id);
});

test("reconciliation releases adopted worktrees after external removal or merge", async () => {
  const repo = await createRepo();
  const removedPath = await mkdtemp(join(tmpdir(), "groveyard-external-remove-"));
  await git(repo, ["worktree", "add", "-b", "native/external-remove", removedPath, "main"]);
  const service = new WorktreeSessionService();
  const removedSession = await service.startSession({ repoPath: repo, workspacePath: removedPath, taskName: "External removal" });
  await git(repo, ["worktree", "remove", "--force", removedPath]);
  const afterRemoval = await service.listSessions(repo);
  assert.equal(afterRemoval.find((session) => session.id === removedSession.session.id)?.status, "released");

  const mergedPath = await mkdtemp(join(tmpdir(), "groveyard-adopted-merge-"));
  await git(repo, ["worktree", "add", "-b", "native/merged-adopted", mergedPath, "main"]);
  const mergedSession = await service.startSession({ repoPath: repo, workspacePath: mergedPath, taskName: "Merged adoption" });
  await writeFile(join(mergedPath, "merged.txt"), "merged\n", "utf8");
  await git(mergedPath, ["add", "merged.txt"]);
  await git(mergedPath, ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "Merged adopted work"]);
  await git(repo, ["merge", "--ff-only", "native/merged-adopted"]);
  const afterMerge = await service.listSessions(repo);
  assert.equal(afterMerge.find((session) => session.id === mergedSession.session.id)?.status, "released");
  assert.equal(existsSync(mergedPath), true);
});

test("startSession rejects detached and different-repository worktrees", async () => {
  const repo = await createRepo();
  const otherRepo = await createRepo();
  const detached = await mkdtemp(join(tmpdir(), "groveyard-detached-worktree-"));
  await git(repo, ["worktree", "add", "--detach", detached, "main"]);
  const service = new WorktreeSessionService();

  await assert.rejects(
    () => service.startSession({ repoPath: repo, workspacePath: detached, taskName: "Detached" }),
    /detached-HEAD/,
  );
  await assert.rejects(
    () => service.startSession({ repoPath: repo, workspacePath: otherRepo, taskName: "Wrong repo" }),
    /different Git repository/,
  );
});

test("createSession remains a managed-worktree compatibility entry point from a linked worktree", async () => {
  const repo = await createRepo();
  const linked = await mkdtemp(join(tmpdir(), "groveyard-create-compat-"));
  await git(repo, ["worktree", "add", "-b", "native/compat", linked, "main"]);
  const service = new WorktreeSessionService();
  const created = await service.createSession({ repoPath: linked, taskName: "Compatibility" });

  assert.equal(created.origin, "managed");
  assert.notEqual(created.worktreePath, linked);
  assert.match(created.worktreePath, /\.agent-worktrees/);
  await service.cleanupSession({ repoPath: linked, sessionId: created.id });
});

test("WorktreeSessionService closes worktree-rooted processes when a session completes", { skip: process.platform === "win32" }, async () => {
  const repo = await createRepo();
  const service = new WorktreeSessionService();
  const created = await service.createSession({
    repoPath: repo,
    taskName: "Close session servers",
    baseBranch: "main",
  });
  const serverProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    cwd: created.worktreePath,
    stdio: "ignore",
  });

  await service.readFile({ repoPath: repo, sessionId: created.id, path: "README.md" });
  await service.writeFile({
    repoPath: repo,
    sessionId: created.id,
    path: "README.md",
    content: "# Completed\n",
  });
  await service.gitStatus({ repoPath: repo, sessionId: created.id });
  await service.gitDiff({ repoPath: repo, sessionId: created.id });
  const committed = await service.commitSession({
    repoPath: repo,
    sessionId: created.id,
    message: "Commit session changes",
  });

  assert.equal(committed.session.status, "completed");
  await assertChildExited(serverProcess);
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

test("WorktreeSessionService rejects path escape attempts", { skip: process.platform === "win32" }, async () => {
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

  assert.ok(created.worktreePath.includes(".custom-worktrees"));
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

async function assertChildExited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Expected child process ${child.pid ?? "unknown"} to exit.`));
    }, 4_000);

    child.once("exit", () => {
      clearTimeout(timeout);
      resolvePromise();
    });
  });
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
    origin: "managed",
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
