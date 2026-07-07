import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loadConfig } from "./config.js";
import { resolveRepoRoot } from "./git.js";
import { WorktreeSessionService } from "./lifecycle.js";
import type { SessionRecord } from "./sessions.js";

type ParsedArgs = {
  command: string;
  repoPath?: string;
  positional: string[];
  json: boolean;
  force: boolean;
};

export async function runCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const service = new WorktreeSessionService();

  try {
    if (args.positional.includes("--help") || args.positional.includes("-h")) {
      printHelp();
      return;
    }

    switch (args.command) {
      case "help":
      case "--help":
      case "-h":
        printHelp();
        return;
      case "doctor":
        await doctor(args);
        return;
      case "init":
        await init(args);
        return;
      case "sessions":
        await sessions(service, args);
        return;
      case "inspect":
        await inspect(service, args);
        return;
      case "commit":
        await commit(service, args);
        return;
      case "clean":
        await clean(service, args);
        return;
      default:
        throw new Error(`Unknown command: ${args.command}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  let repoPath: string | undefined;
  let json = false;
  let force = false;

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];

    if (value === "--repo") {
      repoPath = rest[index + 1];
      index += 1;
      continue;
    }

    if (value?.startsWith("--repo=")) {
      repoPath = value.slice("--repo=".length);
      continue;
    }

    if (value === "--json") {
      json = true;
      continue;
    }

    if (value === "--force") {
      force = true;
      continue;
    }

    if (value) {
      positional.push(value);
    }
  }

  return {
    command,
    repoPath,
    positional,
    json,
    force,
  };
}

async function init(args: ParsedArgs): Promise<void> {
  const repoRoot = await resolveRepoRoot(resolve(args.repoPath ?? process.cwd()));
  const configPath = join(repoRoot, ".groveyard.yml");

  if (existsSync(configPath) && !args.force) {
    throw new Error(".groveyard.yml already exists. Use --force to overwrite it.");
  }

  const commands = await detectCommandProfiles(repoRoot);
  await writeFile(configPath, renderConfig(commands), "utf8");

  const report = {
    status: "created",
    repoRoot,
    configPath,
    commands,
  };

  if (args.json) {
    printJson(report);
    return;
  }

  console.log("Created .groveyard.yml");
  console.log("");
  console.log("Worktrees: .agent-worktrees");
  console.log("Branch prefix: agent/");
  console.log("Dirty base: rejected");
  console.log(`Command profiles: ${Object.keys(commands).length ? Object.keys(commands).join(", ") : "none"}`);
  console.log("");
  console.log("Next:");
  console.log("  groveyard doctor");
}

async function doctor(args: ParsedArgs): Promise<void> {
  const repoRoot = await resolveRepoRoot(resolve(args.repoPath ?? process.cwd()));
  const config = await loadConfig(repoRoot);
  const configPath = resolve(repoRoot, ".groveyard.yml");

  const report = {
    status: "ok",
    repoRoot,
    configPath,
    configExists: existsSync(configPath),
    config,
  };

  if (args.json) {
    printJson(report);
    return;
  }

  console.log("Groveyard doctor: ok");
  console.log(`Repo: ${repoRoot}`);
  console.log(`Config: ${report.configExists ? configPath : "defaults"}`);
  console.log(`Worktrees: ${config.worktreesRoot}`);
  console.log(`Branch prefix: ${config.branchPrefix}`);
  console.log(`Dirty base: ${config.allowDirtyBase ? "allowed" : "rejected"}`);
  console.log(`Command profiles: ${Object.keys(config.commands).length ? Object.keys(config.commands).join(", ") : "none"}`);
}

async function sessions(service: WorktreeSessionService, args: ParsedArgs): Promise<void> {
  const rows = await service.listSessions(args.repoPath);

  if (args.json) {
    printJson(rows);
    return;
  }

  if (rows.length === 0) {
    console.log("No Groveyard sessions found.");
    return;
  }

  for (const session of rows) {
    console.log(formatSessionLine(session));
  }
}

async function inspect(service: WorktreeSessionService, args: ParsedArgs): Promise<void> {
  const sessionId = requireSessionId(args);
  const [session, status] = await Promise.all([
    service.getSession({ repoPath: args.repoPath, sessionId }),
    service.gitStatus({ repoPath: args.repoPath, sessionId }),
  ]);

  const result = {
    session,
    status: status.status,
  };

  if (args.json) {
    printJson(result);
    return;
  }

  console.log(formatSessionLine(session));
  console.log(`Repo: ${session.repoPath}`);
  console.log(`Worktree: ${session.worktreePath}`);
  console.log(`Branch: ${session.branch}`);
  console.log(`Base: ${session.baseBranch}`);
  console.log(`Updated: ${session.updatedAt}`);
  console.log("Status:");
  console.log(status.status || "  clean");
}

async function clean(service: WorktreeSessionService, args: ParsedArgs): Promise<void> {
  const sessionId = requireSessionId(args);
  const session = await service.cleanupSession({ repoPath: args.repoPath, sessionId });

  if (args.json) {
    printJson(session);
    return;
  }

  console.log(`Cleaned ${session.id}`);
}

async function commit(service: WorktreeSessionService, args: ParsedArgs): Promise<void> {
  const sessionId = requireSessionId(args);
  const message = readOptionValue(args.positional, "-m") ?? readOptionValue(args.positional, "--message");

  if (!message) {
    throw new Error("commit requires a message. Use -m \"message\".");
  }

  const result = await service.commitSession({ repoPath: args.repoPath, sessionId, message });

  if (args.json) {
    printJson(result);
    return;
  }

  console.log(`Committed ${result.commit.sha}`);
  console.log(`Branch: ${result.session.branch}`);
  console.log(`Status: ${result.status || "clean"}`);
}

function requireSessionId(args: ParsedArgs): string {
  const sessionId = args.positional[0];

  if (!sessionId) {
    throw new Error(`${args.command} requires a session ID.`);
  }

  return sessionId;
}

function formatSessionLine(session: SessionRecord): string {
  return `${session.id}  ${session.status.padEnd(9)}  ${session.branch}  ${session.taskName}`;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp(): void {
  console.log(`Groveyard

Usage:
  groveyard                         Start the stdio MCP server
  groveyard init [--repo PATH]      Create .groveyard.yml
  groveyard doctor [--repo PATH]    Check repo/config readiness
  groveyard sessions [--repo PATH]  List registered sessions
  groveyard inspect <sessionId>     Show session metadata and status
  groveyard commit <sessionId> -m "message"
  groveyard clean <sessionId>       Remove a registered session worktree

Options:
  --repo PATH   Path inside the Git repository
  --json        Print JSON output for CLI commands
  --force       Overwrite files for commands that support it
`);
}

function readOptionValue(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);

  if (index === -1) {
    const prefix = `${name}=`;
    return values.find((value) => value.startsWith(prefix))?.slice(prefix.length);
  }

  return values[index + 1];
}

async function detectCommandProfiles(repoRoot: string): Promise<Record<string, string>> {
  const packageJsonPath = join(repoRoot, "package.json");

  if (!existsSync(packageJsonPath)) {
    return {};
  }

  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };
  const scripts = packageJson.scripts ?? {};
  const commands: Record<string, string> = {};

  for (const scriptName of ["test", "build", "lint", "typecheck"]) {
    if (scripts[scriptName]) {
      commands[scriptName] = scriptName === "test" ? "npm test" : `npm run ${scriptName}`;
    }
  }

  return commands;
}

function renderConfig(commands: Record<string, string>): string {
  const lines = ["worktreesRoot: .agent-worktrees", "branchPrefix: agent/", "allowDirtyBase: false", "commands:"];
  const entries = Object.entries(commands);

  if (entries.length === 0) {
    lines.push("  {}");
  } else {
    for (const [name, command] of entries) {
      lines.push(`  ${name}: ${command}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
