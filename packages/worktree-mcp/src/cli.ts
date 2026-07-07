import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { loadConfig } from "./config.js";
import { resolveRepoRoot } from "./git.js";
import { WorktreeSessionService } from "./lifecycle.js";
import type { SessionRecord } from "./sessions.js";

type ParsedArgs = {
  command: string;
  repoPath?: string;
  positional: string[];
  json: boolean;
};

export async function runCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const service = new WorktreeSessionService();

  try {
    switch (args.command) {
      case "help":
      case "--help":
      case "-h":
        printHelp();
        return;
      case "doctor":
        await doctor(args);
        return;
      case "sessions":
        await sessions(service, args);
        return;
      case "inspect":
        await inspect(service, args);
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

    if (value) {
      positional.push(value);
    }
  }

  return {
    command,
    repoPath,
    positional,
    json,
  };
}

async function doctor(args: ParsedArgs): Promise<void> {
  const repoRoot = await resolveRepoRoot(resolve(args.repoPath ?? process.cwd()));
  const config = await loadConfig(repoRoot);
  const configPath = resolve(repoRoot, ".worktree-mcp.yml");

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

  console.log("Worktree MCP doctor: ok");
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
    console.log("No Worktree MCP sessions found.");
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
  console.log(`Worktree MCP

Usage:
  worktree-mcp                         Start the stdio MCP server
  worktree-mcp doctor [--repo PATH]    Check repo/config readiness
  worktree-mcp sessions [--repo PATH]  List registered sessions
  worktree-mcp inspect <sessionId>     Show session metadata and status
  worktree-mcp clean <sessionId>       Remove a registered session worktree

Options:
  --repo PATH   Path inside the Git repository
  --json        Print JSON output for CLI commands
`);
}
