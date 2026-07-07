import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "./config.js";

test("loadConfig returns conservative defaults without a config file", async () => {
  const repo = await mkdtemp(join(tmpdir(), "worktree-mcp-config-"));

  assert.deepEqual(await loadConfig(repo), {
    worktreesRoot: ".agent-worktrees",
    branchPrefix: "agent/",
    allowDirtyBase: false,
    commands: {},
  });
});

test("loadConfig parses configured worktree settings", async () => {
  const repo = await mkdtemp(join(tmpdir(), "worktree-mcp-config-"));
  await writeFile(
    join(repo, ".worktree-mcp.yml"),
    `worktreesRoot: .custom-worktrees
branchPrefix: codex/
allowDirtyBase: true
commands:
  test: npm test
`,
    "utf8",
  );

  assert.deepEqual(await loadConfig(repo), {
    worktreesRoot: ".custom-worktrees",
    branchPrefix: "codex/",
    allowDirtyBase: true,
    commands: {
      test: "npm test",
    },
  });
});

test("loadConfig rejects unsafe roots and branch prefixes", async () => {
  const repo = await mkdtemp(join(tmpdir(), "worktree-mcp-config-"));

  await writeFile(join(repo, ".worktree-mcp.yml"), "worktreesRoot: ../outside\n", "utf8");
  await assert.rejects(() => loadConfig(repo), /Path must not escape the repo/);

  await writeFile(join(repo, ".worktree-mcp.yml"), "branchPrefix: ../bad\n", "utf8");
  await assert.rejects(() => loadConfig(repo), /Branch prefix contains unsafe characters/);
});
