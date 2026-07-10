import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

import { getClientAdapters, type SetupContext } from "./client-adapters.js";

const execFileAsync = promisify(execFile);
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "index.js");

test("setup configures a fresh repository for an explicit Codex client", async () => {
  const repo = await createRepo();
  const home = await createHome();
  await mkdir(join(home, ".codex"), { recursive: true });

  const report = await runSetup(repo, home, ["--client", "codex", "--json"]);
  assert.equal(report.status, "ready");
  assert.deepEqual(report.connection.selectedClientIds, ["codex"]);
  assert.equal(report.connection.targets[0]?.verified, true);

  assert.equal(existsSync(join(repo, ".groveyard.yml")), true);
  assert.match(await readFile(join(repo, ".groveyard", "AGENTS.md"), "utf8"), /start_session|create_session/);
  assert.match(await readFile(join(repo, ".gitignore"), "utf8"), /^\.agent-worktrees\/$/m);
  assert.match(await readFile(join(repo, "AGENTS.md"), "utf8"), /## Groveyard workspace policy/);

  const codex = await readFile(join(home, ".codex", "config.toml"), "utf8");
  assert.match(codex, /command = "npx"/);
  assert.match(codex, /GROVEYARD_MANAGED_VERSION = "1"/);
  assert.match(codex, new RegExp(escapeRegExp(repo)));
});

test("setup selects the current VS Code environment and leaves other detected clients untouched", async () => {
  const repo = await createRepo();
  const home = await createHome();
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(join(home, ".codex", "config.toml"), "# keep\n", "utf8");
  await mkdir(dirname(vscodeConfigPath(home)), { recursive: true });

  const report = await runSetup(repo, home, ["--json"], { VSCODE_PID: "123" });
  assert.equal(report.status, "ready");
  assert.deepEqual(report.connection.selectedClientIds, ["vscode"]);
  assert.equal(await readFile(join(home, ".codex", "config.toml"), "utf8"), "# keep\n");

  const vscode = JSON.parse(await readFile(vscodeConfigPath(home), "utf8")) as { servers: Record<string, unknown> };
  assert.equal(Object.keys(vscode.servers).length, 1);
  assert.match(await readFile(join(repo, ".github", "copilot-instructions.md"), "utf8"), /Groveyard workspace policy/);
  assert.equal(existsSync(join(repo, "AGENTS.md")), false);
});

test("setup is idempotent and preserves repository config and unrelated client settings", async () => {
  const repo = await createRepo();
  const home = await createHome();
  const customConfig = "worktreesRoot: .custom-worktrees\nbranchPrefix: custom/\nallowDirtyBase: true\ncommands: {}\n";
  await writeFile(join(repo, ".groveyard.yml"), customConfig, "utf8");
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(join(home, ".codex", "config.toml"), "[features]\nweb_search = true\n", "utf8");

  const first = await runSetup(repo, home, ["--client", "codex", "--json"]);
  const firstConfig = await readFile(join(home, ".codex", "config.toml"), "utf8");
  const second = await runSetup(repo, home, ["--client", "codex", "--json"]);
  const secondConfig = await readFile(join(home, ".codex", "config.toml"), "utf8");

  assert.equal(first.status, "ready");
  assert.equal(second.connection.targets[0]?.action, "unchanged");
  assert.equal(await readFile(join(repo, ".groveyard.yml"), "utf8"), customConfig);
  assert.equal(firstConfig, secondConfig);
  assert.equal(secondConfig.split(/\r?\n/).filter((line) => /^\[mcp_servers\.[^.\]]+\]$/.test(line)).length, 1);
  assert.equal((await readFile(join(repo, "AGENTS.md"), "utf8")).match(/<!-- groveyard:start -->/g)?.length, 1);
  assert.match(secondConfig, /\[features\]/);
});

test("setup --force regenerates an existing repository configuration", async () => {
  const repo = await createRepo();
  const home = await createHome();
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(join(repo, ".groveyard.yml"), "worktreesRoot: .old\nbranchPrefix: old/\ncommands: {}\n", "utf8");

  const report = await runSetup(repo, home, ["--client", "codex", "--force", "--json"]);
  assert.equal(report.status, "ready");
  assert.equal(report.initialization.config, "regenerated");
  assert.match(await readFile(join(repo, ".groveyard.yml"), "utf8"), /worktreesRoot: \.agent-worktrees/);
});

test("invalid existing Groveyard configuration fails before repository or client files change", async () => {
  const repo = await createRepo();
  const home = await createHome();
  const clientPath = join(home, ".codex", "config.toml");
  await mkdir(dirname(clientPath), { recursive: true });
  await writeFile(clientPath, "# keep\n", "utf8");
  await writeFile(join(repo, ".groveyard.yml"), "worktreesRoot: ../escape\n", "utf8");

  const report = await runSetupFailure(repo, home, ["--client", "codex", "--json"]);
  assert.equal(report.status, "error");
  assert.equal(await readFile(clientPath, "utf8"), "# keep\n");
  assert.equal(existsSync(join(repo, ".gitignore")), false);
  assert.equal(existsSync(join(repo, ".groveyard", "AGENTS.md")), false);
});

test("conflicting instruction markers fail before client configuration changes", async () => {
  const repo = await createRepo();
  const home = await createHome();
  const clientPath = join(home, ".codex", "config.toml");
  await mkdir(dirname(clientPath), { recursive: true });
  await writeFile(clientPath, "# keep\n", "utf8");
  await writeFile(join(repo, "AGENTS.md"), "<!-- groveyard:start -->\nmissing end\n", "utf8");

  const report = await runSetupFailure(repo, home, ["--client", "codex", "--json"]);
  assert.equal(report.status, "error");
  assert.match(report.error ?? "", /Conflicting Groveyard instruction markers/);
  assert.equal(await readFile(clientPath, "utf8"), "# keep\n");
});

test("setup creates a backup before updating an existing client configuration", async () => {
  const repo = await createRepo();
  const home = await createHome();
  const configPath = vscodeConfigPath(home);
  const original = `${JSON.stringify({ servers: { existing: { command: "other" } }, setting: true }, null, 2)}\n`;
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, original, "utf8");

  const report = await runSetup(repo, home, ["--client", "vscode", "--json"]);
  assert.equal(report.status, "ready");
  assert.equal(await readFile(`${configPath}.groveyard-backup`, "utf8"), original);

  const config = JSON.parse(await readFile(configPath, "utf8")) as { setting: boolean; servers: Record<string, unknown> };
  assert.equal(config.setting, true);
  assert.ok(config.servers.existing);
  assert.equal(Object.keys(config.servers).length, 2);
});

test("malformed selected client JSON is left unchanged and produces manual instructions", async () => {
  const repo = await createRepo();
  const home = await createHome();
  const configPath = vscodeConfigPath(home);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, "{ malformed", "utf8");

  const report = await runSetup(repo, home, ["--client", "vscode", "--json"]);
  assert.equal(report.status, "manual_connection_required");
  assert.equal(report.connection.targets[0]?.action, "manual");
  assert.match(report.connection.targets[0]?.error ?? "", /malformed/i);
  assert.equal(await readFile(configPath, "utf8"), "{ malformed");
  assert.equal(existsSync(`${configPath}.groveyard-backup`), false);
  assert.equal(existsSync(join(repo, ".groveyard.yml")), true);
});

test("malformed Codex TOML is left unchanged", async () => {
  const repo = await createRepo();
  const home = await createHome();
  const configPath = join(home, ".codex", "config.toml");
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, "[broken\n", "utf8");

  const report = await runSetup(repo, home, ["--client", "codex", "--json"]);
  assert.equal(report.status, "manual_connection_required");
  assert.equal(report.connection.targets[0]?.action, "manual");
  assert.match(report.connection.targets[0]?.error ?? "", /malformed TOML/i);
  assert.equal(await readFile(configPath, "utf8"), "[broken\n");
  assert.equal(existsSync(`${configPath}.groveyard-backup`), false);
});

test("setup --all configures every detected client but default setup configures one", async () => {
  const repo = await createRepo();
  const home = await createHome();
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(dirname(vscodeConfigPath(home)), { recursive: true });

  const defaultReport = await runSetup(repo, home, ["--json"]);
  assert.equal(defaultReport.connection.selectedClientIds.length, 1);

  const allReport = await runSetup(repo, home, ["--all", "--json"]);
  assert.deepEqual(new Set(allReport.connection.selectedClientIds), new Set(["codex", "vscode"]));
  assert.equal(allReport.connection.targets.every((target: { verified: boolean }) => target.verified), true);
});

test("setup --help does not create repository files", async () => {
  const repo = await createRepo();
  const home = await createHome();
  const result = await runCli(repo, home, ["setup", "--help"]);
  assert.match(result.stdout, /groveyard setup/);
  assert.equal(existsSync(join(repo, ".groveyard.yml")), false);
});

test("adapter uninstall removes only the owned repo-specific server entry", async () => {
  const repo = await createRepo();
  const home = await createHome();
  const configPath = vscodeConfigPath(home);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({ servers: { unrelated: { command: "keep" } }, setting: "keep" }, null, 2)}\n`, "utf8");
  const context: SetupContext = {
    repoRoot: repo,
    serverName: "groveyard_uninstall_test",
    agentInstructionsPath: join(repo, ".groveyard", "AGENTS.md"),
    environment: { kind: "local", label: "Local", evidence: [], home },
  };
  const vscode = getClientAdapters().find((adapter) => adapter.id === "vscode")!;
  assert.equal((await vscode.install(context)).action, "updated");
  assert.equal((await vscode.uninstall(context)).action, "removed");

  const config = JSON.parse(await readFile(configPath, "utf8")) as { setting: string; servers: Record<string, unknown> };
  assert.equal(config.setting, "keep");
  assert.deepEqual(config.servers, { unrelated: { command: "keep" } });
});

test("doctor succeeds after setup and includes the MCP handshake", async () => {
  const repo = await createRepo();
  const home = await createHome();
  await mkdir(dirname(vscodeConfigPath(home)), { recursive: true });
  await runSetup(repo, home, ["--client", "vscode", "--json"]);

  const result = await runCli(repo, home, ["doctor", "--repo", repo, "--json"]);
  const report = JSON.parse(result.stdout) as {
    status: string;
    readiness: { checks: Array<{ id: string; ok: boolean }> };
    clients: Array<{ id: string; verified: boolean }>;
  };
  assert.equal(report.status, "ok");
  assert.equal(report.readiness.checks.find((check) => check.id === "mcp-handshake")?.ok, true);
  assert.equal(report.clients.find((client) => client.id === "vscode")?.verified, true);
});

type JsonReport = {
  status: string;
  error?: string;
  initialization: { config: string };
  connection: {
    selectedClientIds: string[];
    targets: Array<{ action: string; verified: boolean; error?: string }>;
  };
};

async function runSetup(repo: string, home: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<any> {
  const result = await runCli(repo, home, ["setup", "--repo", repo, ...args], env);
  return JSON.parse(result.stdout) as JsonReport;
}

async function runSetupFailure(repo: string, home: string, args: string[]): Promise<any> {
  try {
    await runCli(repo, home, ["setup", "--repo", repo, ...args]);
    throw new Error("Expected setup to fail.");
  } catch (error) {
    if (!(error instanceof Error) || !("stdout" in error)) throw error;
    return JSON.parse(String((error as Error & { stdout: string }).stdout));
  }
}

async function runCli(repo: string, home: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string }> {
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith("CODEX_") || key.startsWith("VSCODE_") || key.startsWith("CLAUDE_") || key.startsWith("CLAUDECODE")) delete childEnv[key];
  }
  return execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: repo,
    env: {
      ...childEnv,
      HOME: home,
      PATH: process.env.PATH,
      GROVEYARD_TEST_DISABLE_EXECUTABLE_DETECTION: "1",
      CODEX_THREAD_ID: "",
      CODEX_SANDBOX: "",
      VSCODE_PID: "",
      VSCODE_IPC_HOOK_CLI: "",
      TERM_PROGRAM: "",
      ...env,
    },
  });
}

async function createHome(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "groveyard-setup-home-")));
}

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "groveyard-setup-repo-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "# Test\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: repo });
  await execFileAsync("git", ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "Initial commit"], { cwd: repo });
  return realpath(repo);
}

function vscodeConfigPath(home: string): string {
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Code", "User", "mcp.json");
  if (process.platform === "win32") return join(home, "AppData", "Roaming", "Code", "User", "mcp.json");
  return join(home, ".config", "Code", "User", "mcp.json");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
