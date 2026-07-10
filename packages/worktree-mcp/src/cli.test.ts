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

  const { stdout } = await runCli(["doctor", "--repo", repo, "--json"], { reject: false });
  const report = JSON.parse(stdout) as { status: string; repoRoot: string; config: { worktreesRoot: string; branchPrefix: string; allowDirtyBase: boolean } };

  assert.equal(report.status, "error");
  assert.equal(report.repoRoot, repo);
  assert.equal(report.config.worktreesRoot, ".custom-worktrees");
  assert.equal(report.config.branchPrefix, "cli/");
  assert.equal(report.config.allowDirtyBase, true);
});

test("CLI doctor prints a readable non-JSON report", async () => {
  const repo = await createRepo();
  const { stdout } = await runCli(["doctor", "--repo", repo], { reject: false });

  assert.match(stdout, /____/);
  assert.match(stdout, /Doctor/);
  assert.match(stdout, /Groveyard needs attention/);
  assert.match(stdout, /Command profiles: none/);
  assert.match(stdout, /groveyard setup/);
});

test("CLI terminal banner matches the website ASCII art", async () => {
  const repo = await createRepo();
  const { stdout } = await runCli(["sessions", "--repo", repo]);

  assert.match(stdout, /____/);
  assert.match(stdout, /\\____\|_\|/);
  assert.match(stdout, /No Groveyard sessions found/);
});

test("CLI connect prints MCP config snippets", async () => {
  const repo = await createRepo();
  const serverName = expectedConnectServerName(repo);
  const { stdout } = await runCli(["connect", "--repo", repo]);

  assert.match(stdout, /Connect/);
  assert.match(stdout, new RegExp(String.raw`\[mcp_servers\.${escapeRegExp(serverName)}\]`));
  assert.match(stdout, /"mcpServers"/);
  assert.match(stdout, new RegExp(escapeRegExp(`"${serverName}"`)));
  assert.match(stdout, /"@groveyard\/mcp"/);
  assert.match(stdout, /agent instructions/i);
  assert.match(stdout, /\.groveyard\/AGENTS\.md/);
  assert.match(stdout, new RegExp(escapeRegExp(repo)));
});

test("CLI connect reports snippets as JSON", async () => {
  const repo = await createRepo();
  const { stdout } = await runCli(["connect", "--repo", repo, "--json"]);
  const report = JSON.parse(stdout) as {
    status: string;
    repoRoot: string;
    codexToml: string;
    mcpJson: string;
    agentInstructionsPath: string;
    agentInstructionText: string;
    serverName: string;
    targets: Array<{ name: string }>;
  };
  const serverName = expectedConnectServerName(repo);

  assert.equal(report.status, "ok");
  assert.equal(report.repoRoot, repo);
  assert.equal(report.serverName, serverName);
  assert.ok(report.targets.some((target) => target.name === "Codex"));
  assert.match(report.codexToml, new RegExp(String.raw`\[mcp_servers\.${escapeRegExp(serverName)}\]`));
  assert.match(report.codexToml, /GROVEYARD_AGENT_INSTRUCTIONS/);
  assert.match(report.mcpJson, new RegExp(escapeRegExp(`"${serverName}"`)));
  assert.match(report.mcpJson, /"GROVEYARD_REPO"/);
  assert.match(report.mcpJson, /"GROVEYARD_AGENT_INSTRUCTIONS"/);
  assert.equal(report.agentInstructionsPath, join(repo, ".groveyard", "AGENTS.md"));
  assert.match(report.agentInstructionText, /Before code-changing tasks/);
});

test("CLI connect can write detected config files", async () => {
  const repo = await createRepo();
  const home = await mkdtemp(join(tmpdir(), "groveyard-home-"));
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(join(home, ".cursor"), { recursive: true });
  await writeFile(join(home, ".codex", "config.toml"), "# existing config\n", "utf8");

  const { stdout } = await runCli(["connect", "--repo", repo, "--yes", "--all"], {
    env: {
      HOME: home,
    },
  });

  const codexConfig = await readFile(join(home, ".codex", "config.toml"), "utf8");
  const cursorConfig = JSON.parse(await readFile(join(home, ".cursor", "mcp.json"), "utf8")) as {
    mcpServers: Record<string, { command: string; args: string[]; env: { GROVEYARD_REPO: string; GROVEYARD_AGENT_INSTRUCTIONS: string } }>;
  };
  const serverName = expectedConnectServerName(repo);
  const cursorServer = cursorConfig.mcpServers[serverName];

  assert.match(stdout, /Installed Groveyard MCP/);
  assert.match(stdout, /agent instructions/i);
  assert.match(codexConfig, new RegExp(String.raw`\[mcp_servers\.${escapeRegExp(serverName)}\]`));
  assert.match(codexConfig, new RegExp(escapeRegExp(repo)));
  assert.match(codexConfig, /GROVEYARD_AGENT_INSTRUCTIONS/);
  assert.equal(cursorServer?.command, "npx");
  assert.deepEqual(cursorServer?.args, ["-y", "@groveyard/mcp"]);
  assert.equal(cursorServer?.env.GROVEYARD_REPO, repo);
  assert.equal(cursorServer?.env.GROVEYARD_AGENT_INSTRUCTIONS, join(repo, ".groveyard", "AGENTS.md"));
});

test("CLI connect adds a repo-scoped Codex server without replacing other Groveyard repos", async () => {
  const oldRepo = await createRepo();
  const repo = await createRepo();
  const home = await mkdtemp(join(tmpdir(), "groveyard-home-"));
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(
    join(home, ".codex", "config.toml"),
    `[mcp_servers.groveyard]
command = "npx"
args = ["-y", "@groveyard/mcp"]

[mcp_servers.groveyard.env]
GROVEYARD_REPO = ${JSON.stringify(oldRepo)}
GROVEYARD_AGENT_INSTRUCTIONS = ${JSON.stringify(join(oldRepo, ".groveyard", "AGENTS.md"))}

[plugins."browser@openai-bundled"]
enabled = true
`,
    "utf8",
  );

  await runCli(["connect", "--repo", repo, "--yes"], {
    env: {
      HOME: home,
    },
  });

  const codexConfig = await readFile(join(home, ".codex", "config.toml"), "utf8");
  const serverName = expectedConnectServerName(repo);

  assert.equal(codexConfig.match(/\[mcp_servers\.groveyard\]/g)?.length, 1);
  assert.equal(codexConfig.match(/\[mcp_servers\.groveyard\.env\]/g)?.length, 1);
  assert.match(codexConfig, new RegExp(escapeRegExp(oldRepo)));
  assert.equal(codexConfig.match(new RegExp(String.raw`\[mcp_servers\.${escapeRegExp(serverName)}\]`, "g"))?.length, 1);
  assert.equal(codexConfig.match(new RegExp(String.raw`\[mcp_servers\.${escapeRegExp(serverName)}\.env\]`, "g"))?.length, 1);
  assert.match(codexConfig, new RegExp(escapeRegExp(repo)));
  assert.match(codexConfig, /\[plugins\."browser@openai-bundled"\]/);
});

test("CLI connect updates the same repo-scoped Codex server without duplicating env tables", async () => {
  const oldRepo = await createRepo();
  const repo = await createRepo();
  const home = await mkdtemp(join(tmpdir(), "groveyard-home-"));
  const serverName = "groveyard_custom";
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(
    join(home, ".codex", "config.toml"),
    `[mcp_servers.${serverName}]
command = "npx"
args = ["-y", "@groveyard/mcp"]

[mcp_servers.${serverName}.env]
GROVEYARD_REPO = ${JSON.stringify(oldRepo)}
GROVEYARD_AGENT_INSTRUCTIONS = ${JSON.stringify(join(oldRepo, ".groveyard", "AGENTS.md"))}

[plugins."browser@openai-bundled"]
enabled = true
`,
    "utf8",
  );

  await runCli(["connect", "--repo", repo, "--name", serverName, "--yes"], {
    env: {
      HOME: home,
    },
  });

  const codexConfig = await readFile(join(home, ".codex", "config.toml"), "utf8");

  assert.equal(codexConfig.match(new RegExp(String.raw`\[mcp_servers\.${serverName}\]`, "g"))?.length, 1);
  assert.equal(codexConfig.match(new RegExp(String.raw`\[mcp_servers\.${serverName}\.env\]`, "g"))?.length, 1);
  assert.doesNotMatch(codexConfig, new RegExp(escapeRegExp(oldRepo)));
  assert.match(codexConfig, new RegExp(escapeRegExp(repo)));
  assert.match(codexConfig, /\[plugins\."browser@openai-bundled"\]/);
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

  const humanInspect = await runCli(["inspect", session.id, "--repo", repo]);
  assert.match(humanInspect.stdout, /Handoff report/);
  assert.match(humanInspect.stdout, /Changed files/);
  assert.match(humanInspect.stdout, /changed\.txt/);

  const plainSessions = await runCli(["sessions", "--repo", repo, "--plain"]);
  assert.match(plainSessions.stdout, new RegExp(escapeRegExp(session.id)));
  assert.match(plainSessions.stdout, /CLI smoke/);

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
  const report = JSON.parse(result.stdout) as {
    status: string;
    commands: Record<string, string>;
    agentInstructions: { path: string };
    gitignore: { added: string[] };
  };
  const config = await readFile(join(repo, ".groveyard.yml"), "utf8");
  const agentInstructions = await readFile(join(repo, ".groveyard", "AGENTS.md"), "utf8");
  const gitignore = await readFile(join(repo, ".gitignore"), "utf8");

  assert.equal(report.status, "created");
  assert.deepEqual(report.commands, {
    test: "npm test",
    build: "npm run build",
    lint: "npm run lint",
    typecheck: "npm run typecheck",
  });
  assert.equal(report.agentInstructions.path, join(repo, ".groveyard", "AGENTS.md"));
  assert.deepEqual(report.gitignore.added, [".agent-worktrees/", ".groveyard/"]);
  assert.match(config, /commands:\n  test: npm test\n  build: npm run build\n  lint: npm run lint\n  typecheck: npm run typecheck/);
  assert.match(agentInstructions, /# Groveyard Agent Instructions/);
  assert.match(agentInstructions, /every code-changing task/);
  assert.match(agentInstructions, /start_session/);
  assert.match(agentInstructions, /contract_status/);
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
  await git(repo, ["config", "user.name", "Test User"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await writeFile(join(repo, "README.md"), "# Test\n", "utf8");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "Initial commit"]);

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
  const isolatedHome = options.env?.HOME ?? await mkdtemp(join(tmpdir(), "groveyard-cli-home-"));
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        HOME: isolatedHome,
        PATH: process.env.PATH,
        GROVEYARD_TEST_DISABLE_EXECUTABLE_DETECTION: "1",
        CODEX_THREAD_ID: "",
        CODEX_SANDBOX: "",
        CODEX_PERMISSION_PROFILE: "",
        VSCODE_PID: "",
        VSCODE_IPC_HOOK_CLI: "",
        TERM_PROGRAM: "",
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

function expectedConnectServerName(repoRoot: string): string {
  const repoName = repoRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? "repo";
  const suffix = repoName.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "repo";
  return `groveyard_${suffix}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
