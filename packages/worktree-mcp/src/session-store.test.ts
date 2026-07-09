import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import test from "node:test";

import { DuplicateSessionError, JsonSessionStore, SessionNotFoundError } from "./session-store.js";
import type { SessionRecord } from "./sessions.js";

test("JsonSessionStore adds and lists sessions", async () => {
  const store = await createStore();
  const session = exampleSession();

  await store.add(session);

  assert.deepEqual(await store.list(), [session]);
});

test("JsonSessionStore rejects duplicate session IDs", async () => {
  const store = await createStore();
  const session = exampleSession();

  await store.add(session);
  await assert.rejects(() => store.add(session), DuplicateSessionError);
});

test("JsonSessionStore updates a session and touches updatedAt", async () => {
  const store = await createStore();
  const session = exampleSession();

  await store.add(session);
  const updated = await store.update(session.id, (current) => ({
    ...current,
    status: "completed",
  }));

  assert.equal(updated.status, "completed");
  assert.notEqual(updated.updatedAt, session.updatedAt);
});

test("JsonSessionStore throws for missing sessions", async () => {
  const store = await createStore();

  await assert.rejects(() => store.get("missing"), SessionNotFoundError);
  await assert.rejects(() => store.update("missing", (session) => session), SessionNotFoundError);
});

test("JsonSessionStore persists valid registry JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "worktree-mcp-store-"));
  const registryPath = join(directory, "sessions.json");
  const store = new JsonSessionStore(registryPath);

  await store.add(exampleSession());

  const raw = await readFile(registryPath, "utf8");
  assert.match(raw, /"version": 1/);
  assert.match(raw, /"sessions": \[/);
});

async function createStore(): Promise<JsonSessionStore> {
  const directory = await mkdtemp(join(tmpdir(), "worktree-mcp-store-"));
  return new JsonSessionStore(join(directory, "sessions.json"));
}

function exampleSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "sess_abc123",
    repoPath: "/repo",
    worktreePath: "/repo/.agent-worktrees/sess_abc123",
    branch: "agent/fix-checkout-button",
    baseBranch: "main",
    taskName: "fix checkout button",
    status: "active",
    createdAt: "2026-07-06T12:00:00.000Z",
    updatedAt: "2026-07-06T12:00:00.000Z",
    contract: {
      readPaths: [],
      listedPaths: [],
      writtenPaths: [],
      commandProfilesRun: [],
    },
    ...overrides,
  };
}
