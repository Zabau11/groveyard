import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

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
  yes: boolean;
};

type AgentConfigTarget = {
  id: "codex" | "claude-desktop" | "cursor";
  name: string;
  path: string;
  format: "toml" | "json";
  detected: boolean;
  exists: boolean;
};

type ConnectWriteResult = AgentConfigTarget & {
  action: "created" | "updated" | "skipped";
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
      case "connect":
        await connect(args);
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
  let yes = false;

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

    if (value === "--yes" || value === "-y") {
      yes = true;
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
    yes,
  };
}

async function init(args: ParsedArgs): Promise<void> {
  if (!args.json) {
    printLogo();
    console.log(style("Init", "bold"));
    console.log(style("Preparing a safe workspace config for coding agents.", "dim"));
    console.log("");
  }

  const repoRoot = await withSpinner("Finding Git repository", () => resolveRepoRoot(resolve(args.repoPath ?? process.cwd())), args.json);
  const configPath = join(repoRoot, ".groveyard.yml");

  if (existsSync(configPath) && !args.force) {
    throw new Error(".groveyard.yml already exists. Use --force to overwrite it.");
  }

  const commands = await withSpinner("Detecting package scripts", () => detectCommandProfiles(repoRoot), args.json);
  await withSpinner("Writing .groveyard.yml", () => writeFile(configPath, renderConfig(commands), "utf8"), args.json);

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

  console.log(style("Created .groveyard.yml", "green"));
  console.log("");
  console.log(`${style("Worktrees", "cyan")}: .agent-worktrees`);
  console.log(`${style("Branch prefix", "cyan")}: agent/`);
  console.log(`${style("Dirty base", "cyan")}: rejected`);
  console.log(`${style("Command profiles", "cyan")}: ${formatCommandProfiles(commands)}`);
  console.log("");
  console.log(style("Next", "bold"));
  console.log(`  ${style("groveyard doctor", "green")}`);
}

async function doctor(args: ParsedArgs): Promise<void> {
  if (!args.json) {
    printLogo();
    console.log(style("Doctor", "bold"));
    console.log(style("Checking whether this repo is ready for agent worktrees.", "dim"));
    console.log("");
  }

  const repoRoot = await withSpinner("Inspecting Git repository", () => resolveRepoRoot(resolve(args.repoPath ?? process.cwd())), args.json);
  const config = await withSpinner("Reading Groveyard config", () => loadConfig(repoRoot), args.json);
  const configPath = resolve(repoRoot, ".groveyard.yml");
  const configExists = existsSync(configPath);

  const report = {
    status: "ok",
    repoRoot,
    configPath,
    configExists,
    config,
  };

  if (args.json) {
    printJson(report);
    return;
  }

  console.log(style("Ready for agent worktrees", "green"));
  console.log("");
  console.log(`${style("Repo", "cyan")}: ${repoRoot}`);
  console.log(`${style("Config", "cyan")}: ${configExists ? configPath : style("defaults", "dim")}`);
  console.log(`${style("Worktrees", "cyan")}: ${config.worktreesRoot}`);
  console.log(`${style("Branch prefix", "cyan")}: ${config.branchPrefix}`);
  console.log(`${style("Dirty base", "cyan")}: ${config.allowDirtyBase ? style("allowed", "yellow") : style("rejected", "green")}`);
  console.log(`${style("Command profiles", "cyan")}: ${formatCommandProfiles(config.commands)}`);
  console.log("");
  console.log(style("Next", "bold"));
  console.log(`  ${Object.keys(config.commands).length ? style("groveyard sessions", "green") : style("groveyard init", "green")}`);
}

async function connect(args: ParsedArgs): Promise<void> {
  const repoRoot = await resolveRepoRoot(resolve(args.repoPath ?? process.cwd()));
  const snippets = createConnectSnippets(repoRoot);
  const targets = detectAgentConfigTargets();
  const detectedTargets = targets.filter((target) => target.detected);

  if (args.json) {
    printJson({
      status: "ok",
      repoRoot,
      targets,
      ...snippets,
    });
    return;
  }

  printLogo();
  console.log(style("Connect", "bold"));
  console.log(style("Detected coding agent config files and can add Groveyard for this repo.", "dim"));
  console.log("");
  console.log(`${style("Repo", "cyan")}: ${repoRoot}`);
  console.log("");

  if (detectedTargets.length > 0) {
    console.log(style("Detected", "bold"));

    for (const target of detectedTargets) {
      console.log(`  ${style(target.name, "cyan")} ${target.exists ? style("update", "yellow") : style("create", "green")}`);
      console.log(`    ${target.path}`);
    }
  } else {
    console.log(style("No known agent config folders found yet.", "yellow"));
    console.log("Groveyard looked for Codex, Claude Desktop, and Cursor config locations.");
  }

  console.log("");

  const writeResults = await maybeWriteDetectedConfigs(detectedTargets, repoRoot, args.yes);

  if (writeResults.length > 0) {
    console.log(style("Connected", "bold"));

    for (const result of writeResults) {
      console.log(`  ${style(result.action, result.action === "skipped" ? "dim" : "green")} ${result.name}`);
    }

    console.log("");
    console.log(style("Restart your coding agent so it reloads MCP config.", "dim"));
  } else {
    console.log(style("Manual config", "bold"));
    console.log(style("Codex ~/.codex/config.toml", "dim"));
    console.log(snippets.codexToml);
    console.log("");
    console.log(style("Claude Desktop / Cursor mcpServers JSON", "dim"));
    console.log(snippets.mcpJson);
  }

  console.log("");
  console.log(style("Next", "bold"));
  console.log(`  ${style("groveyard doctor", "green")}`);
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
  groveyard connect [--repo PATH]   Detect agent configs and connect MCP
  groveyard sessions [--repo PATH]  List registered sessions
  groveyard inspect <sessionId>     Show session metadata and status
  groveyard commit <sessionId> -m "message"
  groveyard clean <sessionId>       Remove a registered session worktree

Options:
  --repo PATH   Path inside the Git repository
  --json        Print JSON output for CLI commands
  --force       Overwrite files for commands that support it
  --yes, -y     Confirm prompts for commands that support it
`);
}

function printLogo(): void {
  const logo = [
    "  ____                                      __",
    " / ___|_ __ _____   _____ _   _  __ _ _ __ __| |",
    "| |  _| '__/ _ \\ \\ / / _ \\ | | |/ _` | '__/ _` |",
    "| |_| | | | (_) \\ V /  __/ |_| | (_| | | | (_| |",
    " \\____|_|  \\___/ \\_/ \\___|\\__, |\\__,_|_|  \\__,_|",
    "                          |___/",
  ];

  for (const line of logo) {
    console.log(style(line, "green"));
  }
}

async function withSpinner<T>(label: string, task: () => Promise<T>, silent: boolean): Promise<T> {
  if (silent || !isInteractive()) {
    return task();
  }

  const frames = ["-", "\\", "|", "/"];
  let index = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r\x1b[2K${style(frames[index % frames.length]!, "green")} ${label}`);
    index += 1;
  }, 80);

  try {
    const result = await task();
    clearInterval(timer);
    process.stdout.write(`\r\x1b[2K${style("ok", "green")} ${label}\n`);
    return result;
  } catch (error) {
    clearInterval(timer);
    process.stdout.write(`\r\x1b[2K${style("fail", "red")} ${label}\n`);
    throw error;
  }
}

function formatCommandProfiles(commands: Record<string, string>): string {
  const names = Object.keys(commands);
  return names.length ? names.map((name) => style(name, "green")).join(", ") : style("none", "dim");
}

function createConnectSnippets(repoRoot: string): { codexToml: string; mcpJson: string } {
  const args = ["-y", "@groveyard/mcp"];
  const jsonConfig = {
    mcpServers: {
      groveyard: {
        command: "npx",
        args,
        env: {
          GROVEYARD_REPO: repoRoot,
        },
      },
    },
  };

  return {
    codexToml: [
      "[mcp_servers.groveyard]",
      'command = "npx"',
      'args = ["-y", "@groveyard/mcp"]',
      "",
      "[mcp_servers.groveyard.env]",
      `GROVEYARD_REPO = ${JSON.stringify(repoRoot)}`,
    ].join("\n"),
    mcpJson: JSON.stringify(jsonConfig, null, 2),
  };
}

function detectAgentConfigTargets(): AgentConfigTarget[] {
  const home = homedir();
  const candidates: Array<Omit<AgentConfigTarget, "detected" | "exists">> = [
    {
      id: "codex",
      name: "Codex",
      path: join(home, ".codex", "config.toml"),
      format: "toml",
    },
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      path: join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
      format: "json",
    },
    {
      id: "cursor",
      name: "Cursor",
      path: join(home, ".cursor", "mcp.json"),
      format: "json",
    },
  ];

  return candidates.map((candidate) => {
    const exists = existsSync(candidate.path);
    return {
      ...candidate,
      exists,
      detected: exists || existsSync(dirname(candidate.path)),
    };
  });
}

async function maybeWriteDetectedConfigs(targets: AgentConfigTarget[], repoRoot: string, assumeYes: boolean): Promise<ConnectWriteResult[]> {
  if (targets.length === 0) {
    return [];
  }

  if (!assumeYes && !isInteractive()) {
    return [];
  }

  const results: ConnectWriteResult[] = [];
  const rl = assumeYes ? undefined : createInterface({ input: process.stdin, output: process.stdout });

  try {
    for (const target of targets) {
      const shouldWrite = assumeYes || (rl ? await confirm(rl, `${target.exists ? "Update" : "Create"} ${target.name} config?`) : false);

      if (!shouldWrite) {
        results.push({ ...target, action: "skipped" });
        continue;
      }

      await writeAgentConfig(target, repoRoot);
      results.push({ ...target, action: target.exists ? "updated" : "created" });
    }
  } finally {
    rl?.close();
  }

  return results;
}

async function confirm(rl: ReturnType<typeof createInterface>, question: string): Promise<boolean> {
  const answer = await rl.question(`${question} ${style("[y/N]", "dim")} `);
  return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
}

async function writeAgentConfig(target: AgentConfigTarget, repoRoot: string): Promise<void> {
  await mkdir(dirname(target.path), { recursive: true });

  if (target.format === "toml") {
    await writeFile(target.path, upsertCodexToml(target.exists ? await readFile(target.path, "utf8") : "", repoRoot), "utf8");
    return;
  }

  await writeFile(target.path, upsertMcpJson(target.exists ? await readFile(target.path, "utf8") : "", repoRoot), "utf8");
}

function upsertCodexToml(existing: string, repoRoot: string): string {
  const block = [
    "[mcp_servers.groveyard]",
    'command = "npx"',
    'args = ["-y", "@groveyard/mcp"]',
    "",
    "[mcp_servers.groveyard.env]",
    `GROVEYARD_REPO = ${JSON.stringify(repoRoot)}`,
  ].join("\n");

  const pattern = /\n?\[mcp_servers\.groveyard\][\s\S]*?(?=\n\[mcp_servers\.|\n\[[^\]]+\]|\s*$)/;
  const trimmed = existing.trimEnd();

  if (pattern.test(trimmed)) {
    return `${trimmed.replace(pattern, `\n${block}`)}\n`;
  }

  return `${trimmed ? `${trimmed}\n\n` : ""}${block}\n`;
}

function upsertMcpJson(existing: string, repoRoot: string): string {
  const config = existing.trim() ? (JSON.parse(existing) as { mcpServers?: Record<string, unknown> }) : {};
  config.mcpServers = {
    ...config.mcpServers,
    groveyard: {
      command: "npx",
      args: ["-y", "@groveyard/mcp"],
      env: {
        GROVEYARD_REPO: repoRoot,
      },
    },
  };

  return `${JSON.stringify(config, null, 2)}\n`;
}

function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY && !process.env.CI);
}

function style(value: string, color: "bold" | "dim" | "green" | "cyan" | "yellow" | "red"): string {
  if (!process.stdout.isTTY || process.env.NO_COLOR) {
    return value;
  }

  const codes = {
    bold: ["\x1b[1m", "\x1b[22m"],
    dim: ["\x1b[38;2;158;164;155m", "\x1b[39m"],
    green: ["\x1b[38;2;76;255;146m", "\x1b[39m"],
    cyan: ["\x1b[38;2;76;255;146m", "\x1b[39m"],
    yellow: ["\x1b[38;2;244;211;94m", "\x1b[39m"],
    red: ["\x1b[38;2;255;94;87m", "\x1b[39m"],
  } satisfies Record<typeof color, [string, string]>;

  const [open, close] = codes[color];
  return `${open}${value}${close}`;
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
