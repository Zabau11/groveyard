import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";

import { WorktreeSessionService } from "./lifecycle.js";

const execFileAsync = promisify(execFile);
const distDirectory = dirname(fileURLToPath(import.meta.url));
const cliPath = join(distDirectory, "index.js");

test("CLI doctor reports repo config as JSON", async () => {
  const repo = await createRepo();
  await writeFile(
    join(repo, ".groveyard.yml"),
    `worktreesRoot: .custom-worktrees
branchPrefix: cli/
allowDirtyBase: true
commands:
  test: npm test
`,
    "utf8",
  );

  const { stdout } = await runCli(["doctor", "--repo", repo, "--json"]);
  const report = JSON.parse(stdout) as { status: string; repoRoot: string; config: { worktreesRoot: string; branchPrefix: string; allowDirtyBase: boolean } };

  assert.equal(report.status, "ok");
  assert.equal(report.repoRoot, repo);
  assert.equal(report.config.worktreesRoot, ".custom-worktrees");
  assert.equal(report.config.branchPrefix, "cli/");
  assert.equal(report.config.allowDirtyBase, true);
});

test("CLI doctor prints a readable non-JSON report", async () => {
  const repo = await createRepo();
  const { stdout } = await runCli(["doctor", "--repo", repo]);

  assert.match(stdout, /____/);
  assert.match(stdout, /Doctor/);
  assert.match(stdout, /Ready for agent worktrees/);
  assert.match(stdout, /Command profiles: none/);
  assert.match(stdout, /groveyard init/);
});

test("CLI connect prints MCP config snippets", async () => {
  const repo = await createRepo();
  const { stdout } = await runCli(["connect", "--repo", repo]);

  assert.match(stdout, /Connect/);
  assert.match(stdout, /\[mcp_servers\.groveyard\]/);
  assert.match(stdout, /"mcpServers"/);
  assert.match(stdout, /"@groveyard\/mcp"/);
  assert.match(stdout, new RegExp(escapeRegExp(repo)));
});

test("CLI connect reports snippets as JSON", async () => {
  const repo = await createRepo();
  const { stdout } = await runCli(["connect", "--repo", repo, "--json"]);
  const report = JSON.parse(stdout) as { status: string; repoRoot: string; codexToml: string; mcpJson: string; targets: Array<{ name: string }> };

  assert.equal(report.status, "ok");
  assert.equal(report.repoRoot, repo);
  assert.ok(report.targets.some((target) => target.name === "Codex"));
  assert.match(report.codexToml, /\[mcp_servers\.groveyard\]/);
  assert.match(report.mcpJson, /"GROVEYARD_REPO"/);
});

test("CLI connect can write detected config files", async () => {
  const repo = await createRepo();
  const home = await mkdtemp(join(tmpdir(), "groveyard-home-"));
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(join(home, ".cursor"), { recursive: true });
  await writeFile(join(home, ".codex", "config.toml"), "# existing config\n", "utf8");

  const { stdout } = await runCli(["connect", "--repo", repo, "--yes"], {
    env: {
      HOME: home,
    },
  });

  const codexConfig = await readFile(join(home, ".codex", "config.toml"), "utf8");
  const cursorConfig = JSON.parse(await readFile(join(home, ".cursor", "mcp.json"), "utf8")) as {
    mcpServers: { groveyard: { command: string; args: string[]; env: { GROVEYARD_REPO: string } } };
  };

  assert.match(stdout, /Connected/);
  assert.match(codexConfig, /\[mcp_servers\.groveyard\]/);
  assert.match(codexConfig, new RegExp(escapeRegExp(repo)));
  assert.equal(cursorConfig.mcpServers.groveyard.command, "npx");
  assert.deepEqual(cursorConfig.mcpServers.groveyard.args, ["-y", "@groveyard/mcp"]);
  assert.equal(cursorConfig.mcpServers.groveyard.env.GROVEYARD_REPO, repo);
});

test("CLI dashboard summarizes repo, MCP config, and sessions", async () => {
  const repo = await createRepo();
  await writeFile(join(repo, ".gitignore"), ".agent-worktrees/\n.groveyard/\n", "utf8");
  await writeFile(
    join(repo, ".groveyard.yml"),
    `worktreesRoot: .agent-worktrees
branchPrefix: agent/
allowDirtyBase: false
commands:
  build: npm run build
`,
    "utf8",
  );
  await git(repo, ["add", ".gitignore", ".groveyard.yml"]);
  await git(repo, ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "Configure Groveyard"]);

  const home = await mkdtemp(join(tmpdir(), "groveyard-home-"));
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(
    join(home, ".codex", "config.toml"),
    `[mcp_servers.groveyard]
command = "npx"
args = ["-y", "@groveyard/mcp"]

[mcp_servers.groveyard.env]
GROVEYARD_REPO = ${JSON.stringify(repo)}
`,
    "utf8",
  );

  const service = new WorktreeSessionService();
  const session = await service.createSession({
    repoPath: repo,
    taskName: "Improve dashboard",
    baseBranch: "main",
  });
  await writeFile(join(session.worktreePath, "dashboard.txt"), "changed\n", "utf8");

  const jsonResult = await runCli(["dashboard", "--repo", repo, "--json"], {
    env: {
      HOME: home,
    },
  });
  const report = JSON.parse(jsonResult.stdout) as {
    repoRoot: string;
    configExists: boolean;
    base: { dirty: boolean };
    config: { commandProfiles: string[] };
    sessions: { active: number; dirty: number; items: Array<{ id: string; changedFiles: number }> };
    mcpConfigs: { configured: number };
    next: string[];
  };

  assert.equal(report.repoRoot, repo);
  assert.equal(report.configExists, true);
  assert.equal(report.base.dirty, false);
  assert.deepEqual(report.config.commandProfiles, ["build"]);
  assert.equal(report.sessions.active, 1);
  assert.equal(report.sessions.dirty, 1);
  assert.equal(report.sessions.items[0]?.id, session.id);
  assert.equal(report.sessions.items[0]?.changedFiles, 1);
  assert.equal(report.mcpConfigs.configured, 1);
  assert.ok(report.next.includes(`groveyard inspect ${session.id}`));

  const humanResult = await runCli(["dashboard", "--repo", repo], {
    env: {
      HOME: home,
    },
  });

  assert.match(humanResult.stdout, /____/);
  assert.match(humanResult.stdout, /Dashboard/);
  assert.match(humanResult.stdout, /State: ready/);
  assert.match(humanResult.stdout, /MCP config: Codex/);
  assert.match(humanResult.stdout, /Sessions/);
  assert.match(humanResult.stdout, new RegExp(escapeRegExp(session.id)));
  assert.match(humanResult.stdout, /1 changed/);
});

test("CLI sessions, inspect, and clean operate on persisted sessions", async () => {
  const repo = await createRepo();
  const service = new WorktreeSessionService();
  const session = await service.createSession({
    repoPath: repo,
    taskName: "CLI smoke",
    baseBranch: "main",
  });
  await writeFile(join(session.worktreePath, "changed.txt"), "changed\n", "utf8");

  const sessions = await runCli(["sessions", "--repo", repo, "--json"]);
  const rows = JSON.parse(sessions.stdout) as Array<{ id: string }>;
  assert.equal(rows[0]?.id, session.id);

  const inspected = await runCli(["inspect", session.id, "--repo", repo, "--json"]);
  const inspect = JSON.parse(inspected.stdout) as { session: { id: string }; status: string };
  assert.equal(inspect.session.id, session.id);
  assert.match(inspect.status, /\?\? changed\.txt/);

  const committed = await runCli(["commit", session.id, "-m", "CLI commit", "--repo", repo, "--json"]);
  const commit = JSON.parse(committed.stdout) as { commit: { sha: string; message: string }; status: string };
  assert.match(commit.commit.sha, /^[a-f0-9]{40}$/);
  assert.equal(commit.commit.message, "CLI commit");
  assert.equal(commit.status, "");

  const cleaned = await runCli(["clean", session.id, "--repo", repo, "--json"]);
  const cleanedSession = JSON.parse(cleaned.stdout) as { id: string; status: string };
  assert.equal(cleanedSession.id, session.id);
  assert.equal(cleanedSession.status, "cleaned");
});

test("CLI init creates config from package scripts", async () => {
  const repo = await createRepo();
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify(
      {
        scripts: {
          test: "node --test",
          build: "tsc",
          lint: "eslint .",
          typecheck: "tsc --noEmit",
          dev: "tsx src/index.ts",
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const result = await runCli(["init", "--repo", repo, "--json"]);
  const report = JSON.parse(result.stdout) as { status: string; commands: Record<string, string>; gitignore: { added: string[] } };
  const config = await readFile(join(repo, ".groveyard.yml"), "utf8");
  const gitignore = await readFile(join(repo, ".gitignore"), "utf8");

  assert.equal(report.status, "created");
  assert.deepEqual(report.commands, {
    test: "npm test",
    build: "npm run build",
    lint: "npm run lint",
    typecheck: "npm run typecheck",
  });
  assert.deepEqual(report.gitignore.added, [".agent-worktrees/", ".groveyard/"]);
  assert.match(config, /commands:\n  test: npm test\n  build: npm run build\n  lint: npm run lint\n  typecheck: npm run typecheck/);
  assert.match(gitignore, /# Groveyard\n\.agent-worktrees\/\n\.groveyard\//);
});

test("CLI init preserves existing gitignore entries without duplicating Groveyard ignores", async () => {
  const repo = await createRepo();
  await writeFile(join(repo, ".gitignore"), "node_modules/\n.agent-worktrees\n", "utf8");

  const result = await runCli(["init", "--repo", repo, "--json"]);
  const report = JSON.parse(result.stdout) as { gitignore: { added: string[] } };
  const gitignore = await readFile(join(repo, ".gitignore"), "utf8");
  const normalizedLines = gitignore
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\/+$/, ""));

  assert.deepEqual(report.gitignore.added, [".groveyard/"]);
  assert.match(gitignore, /node_modules/);
  assert.equal(normalizedLines.filter((line) => line === ".agent-worktrees").length, 1);
  assert.equal(normalizedLines.filter((line) => line === ".groveyard").length, 1);
});

test("CLI init refuses overwrite unless forced", async () => {
  const repo = await createRepo();

  await runCli(["init", "--repo", repo]);
  const rejected = await runCli(["init", "--repo", repo], { reject: false });
  assert.equal(rejected.exitCode, 1);
  assert.match(rejected.stderr, /already exists/);

  const forced = await runCli(["init", "--repo", repo, "--force", "--json"]);
  const report = JSON.parse(forced.stdout) as { status: string };
  assert.equal(report.status, "created");
});

test("CLI returns a nonzero exit for missing inspect session ID", async () => {
  const result = await runCli(["inspect"], { reject: false });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /inspect requires a session ID/);
});

test("CLI commit requires a message", async () => {
  const result = await runCli(["commit", "sess_missing"], { reject: false });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /commit requires a message/);
});

test("CLI init help does not create a config file", async () => {
  const repo = await createRepo();
  const result = await runCli(["init", "--repo", repo, "--help"]);

  assert.match(result.stdout, /groveyard init/);
  await assert.rejects(() => readFile(join(repo, ".groveyard.yml"), "utf8"), /ENOENT/);
});

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "groveyard-cli-repo-"));

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

async function runCli(
  args: string[],
  options: { reject?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        ...options.env,
      },
      maxBuffer: 1024 * 1024 * 20,
    });

    return {
      exitCode: 0,
      stdout,
      stderr,
    };
  } catch (error) {
    if (options.reject !== false || !isExecError(error)) {
      throw error;
    }

    return {
      exitCode: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

function isExecError(error: unknown): error is Error & { code?: number | string; stdout?: string; stderr?: string } {
  return error instanceof Error && ("stdout" in error || "stderr" in error || "code" in error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
