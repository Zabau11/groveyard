import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { loadConfig } from "./config.js";
import { getCurrentBranch, gitStatusShort, resolveRepoRoot, runGit } from "./git.js";
import { WorktreeSessionService } from "./lifecycle.js";
import { renderAgentInstructions } from "./mcp-server.js";
import type { SessionRecord } from "./sessions.js";

type ParsedArgs = {
  command: string;
  repoPath?: string;
  positional: string[];
  json: boolean;
  force: boolean;
  plain: boolean;
  yes: boolean;
};

type StyleColor = "bold" | "dim" | "green" | "cyan" | "yellow" | "red";

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

type ConnectSnippets = {
  codexToml: string;
  mcpJson: string;
  agentInstructionsPath: string;
  agentInstructionText: string;
};

type DashboardMcpTarget = AgentConfigTarget & {
  configured: boolean;
  configError?: string;
};

type DashboardSession = {
  id: string;
  taskName: string;
  branch: string;
  status: SessionRecord["status"];
  worktreePath: string;
  updatedAt: string;
  dirty: boolean | null;
  changedFiles: number;
  statusText: string;
  statusError?: string;
};

type DashboardReport = {
  status: "ok";
  repoRoot: string;
  branch: string;
  base: {
    dirty: boolean;
    changedFiles: number;
    statusText: string;
  };
  configPath: string;
  configExists: boolean;
  config: {
    worktreesRoot: string;
    branchPrefix: string;
    allowDirtyBase: boolean;
    commandProfiles: string[];
  };
  sessions: {
    total: number;
    active: number;
    cleaned: number;
    dirty: number;
    clean: number;
    unknown: number;
    items: DashboardSession[];
  };
  mcpConfigs: {
    detected: number;
    configured: number;
    targets: DashboardMcpTarget[];
  };
  next: string[];
};

type HandoffReport = {
  session: SessionRecord;
  state: {
    label: string;
    color: StyleColor;
    summary: string;
  };
  statusText: string;
  changedFiles: string[];
  contract: {
    readyToCommit: boolean;
    requiredActions: string[];
  };
  next: string[];
};

const groveyardIgnoreEntries = [".agent-worktrees/", ".groveyard/"];
const agentInstructionsPath = join(".groveyard", "AGENTS.md");
const groveyardAscii = `  ____                                      __
 / ___|_ __ _____   _____ _   _  __ _ _ __ __| |
| |  _| '__/ _ \\ \\ / / _ \\ | | |/ _\` | '__/ _\` |
| |_| | | | (_) \\ V /  __/ |_| | (_| | | | (_| |
 \\____|_|  \\___/ \\_/ \\___|\\__, |\\__,_|_|  \\__,_|
                          |___/`;

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
      case "dashboard":
        await dashboard(service, args);
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
  let plain = false;
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

    if (value === "--plain") {
      plain = true;
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
    plain,
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
  const agentInstructions = await withSpinner("Writing agent instructions", () => writeAgentInstructions(repoRoot), args.json);
  const gitignore = await withSpinner("Updating .gitignore", () => ensureGroveyardGitignore(repoRoot), args.json);

  const report = {
    status: "created",
    repoRoot,
    configPath,
    agentInstructions,
    commands,
    gitignore,
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
  console.log(`${style("Agent instructions", "cyan")}: ${agentInstructions.path}`);
  console.log(`${style("Ignored", "cyan")}: ${groveyardIgnoreEntries.join(", ")}`);
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
    console.log(style("Agent instructions", "bold"));
    console.log(snippets.agentInstructionText);
    console.log("");
    console.log(style("Restart your coding agent so it reloads MCP config.", "dim"));
  } else {
    console.log(style("Agent instructions", "bold"));
    console.log(snippets.agentInstructionText);
    console.log("");
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

async function dashboard(service: WorktreeSessionService, args: ParsedArgs): Promise<void> {
  if (!args.json) {
    printLogo();
    console.log(style("Dashboard", "bold"));
    console.log(style("The important state for this repo's agent worktrees.", "dim"));
    console.log("");
  }

  const report = await withSpinner("Collecting Groveyard state", () => buildDashboardReport(service, args), args.json);

  if (args.json) {
    printJson(report);
    return;
  }

  printDashboard(report);
}

async function sessions(service: WorktreeSessionService, args: ParsedArgs): Promise<void> {
  const rows = await service.listSessions(args.repoPath);

  if (args.json) {
    printJson(rows);
    return;
  }

  if (rows.length === 0) {
    printLogo();
    console.log("No Groveyard sessions found.");
    return;
  }

  if (!isInteractive() || args.plain) {
    printLogo();
    for (const session of rows) {
      console.log(formatSessionLine(session));
    }
    return;
  }

  printLogo();
  console.log(style("Sessions", "bold"));
  console.log(style("Pick a session to view its handoff report.", "dim"));
  console.log("");

  rows.forEach((session, index) => {
    console.log(formatSessionMenuLine(session, index));
  });

  console.log("");
  const selected = await promptForSession(rows);

  if (!selected) {
    console.log(style("No session selected.", "dim"));
    return;
  }

  console.log("");
  printHandoffReport(await buildHandoffReport(service, args, selected));
}

async function inspect(service: WorktreeSessionService, args: ParsedArgs): Promise<void> {
  const sessionId = requireSessionId(args);
  const repoRoot = await resolveRepoRoot(resolve(args.repoPath ?? process.cwd()));
  const session = await service.getSession({ repoPath: repoRoot, sessionId });
  const status = await readSessionStatus(service, repoRoot, session);

  const result = {
    session,
    status: status.statusText,
  };

  if (args.json) {
    printJson(result);
    return;
  }

  printLogo();
  printHandoffReport(await buildHandoffReport(service, args, session));
}

async function clean(service: WorktreeSessionService, args: ParsedArgs): Promise<void> {
  const sessionId = requireSessionId(args);
  const session = await service.cleanupSession({ repoPath: args.repoPath, sessionId });

  if (args.json) {
    printJson(session);
    return;
  }

  printLogo();
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

  printLogo();
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

function formatSessionMenuLine(session: SessionRecord, index: number): string {
  const statusColor = sessionStatusColor(session.status);
  const task = session.taskName.length > 32 ? `${session.taskName.slice(0, 29)}...` : session.taskName;
  const branch = session.branch.length > 46 ? `${session.branch.slice(0, 43)}...` : session.branch;

  return [
    style(String(index + 1).padStart(2), "cyan"),
    style(session.status.padEnd(9), statusColor),
    task.padEnd(34),
    style(branch, "dim"),
  ].join("  ");
}

async function promptForSession(rows: SessionRecord[]): Promise<SessionRecord | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const answer = await rl.question(`${style("Session number", "cyan")} ${style("[Enter to cancel]", "dim")}: `);
    const value = answer.trim();

    if (!value) {
      return null;
    }

    const index = Number(value);

    if (!Number.isInteger(index) || index < 1 || index > rows.length) {
      console.log(style("Invalid selection.", "yellow"));
      return null;
    }

    return rows[index - 1] ?? null;
  } finally {
    rl.close();
  }
}

async function buildHandoffReport(service: WorktreeSessionService, args: ParsedArgs, session: SessionRecord): Promise<HandoffReport> {
  const repoRoot = await resolveRepoRoot(resolve(args.repoPath ?? process.cwd()));
  const contract = await service.contractStatus({ repoPath: repoRoot, sessionId: session.id });
  const status = await readSessionStatus(service, repoRoot, session);
  const changedFiles = status.statusText ? parseChangedFiles(status.statusText) : await branchChangedFiles(repoRoot, session);
  const state = handoffState(session, status.statusText, changedFiles);
  const requiredActions = session.status === "active" ? contract.requiredActions : [];

  return {
    session,
    state,
    statusText: status.statusText,
    changedFiles,
    contract: {
      readyToCommit: session.status === "active" ? contract.readyToCommit : true,
      requiredActions,
    },
    next: handoffNextSteps(session, status.statusText, changedFiles, requiredActions),
  };
}

async function readSessionStatus(
  service: WorktreeSessionService,
  repoRoot: string,
  session: SessionRecord,
): Promise<{ statusText: string; error?: string }> {
  if (session.status === "cleaned") {
    return { statusText: "" };
  }

  try {
    const status = await service.gitStatus({ repoPath: repoRoot, sessionId: session.id });
    return { statusText: status.status };
  } catch (error) {
    return {
      statusText: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function branchChangedFiles(repoRoot: string, session: SessionRecord): Promise<string[]> {
  const base = session.baseCommit ?? session.baseBranch;

  try {
    const output = await runGit(repoRoot, ["diff", "--name-status", `${base}..${session.branch}`]);
    return parseChangedFiles(output);
  } catch {
    return [];
  }
}

function parseChangedFiles(statusText: string): string[] {
  return statusText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/).slice(1).join(" ") || line);
}

function handoffState(session: SessionRecord, statusText: string, changedFiles: string[]): HandoffReport["state"] {
  if (session.status === "cleaned") {
    return {
      label: "retired",
      color: "dim",
      summary: "merged or cleaned; no worktree remains",
    };
  }

  if (session.status === "completed") {
    return {
      label: "ready",
      color: "green",
      summary: changedFiles.length > 0 ? "clean branch with committed changes" : "clean branch",
    };
  }

  if (statusText.length > 0) {
    return {
      label: "needs review",
      color: "yellow",
      summary: `${changedFiles.length} changed ${changedFiles.length === 1 ? "file" : "files"}`,
    };
  }

  return {
    label: "active",
    color: "green",
    summary: "clean worktree; no pending file changes",
  };
}

function handoffNextSteps(session: SessionRecord, statusText: string, changedFiles: string[], requiredActions: string[]): string[] {
  if (session.status === "cleaned") {
    return ["No action needed. This session has been retired."];
  }

  if (requiredActions.length > 0) {
    return requiredActions;
  }

  if (statusText.length > 0) {
    return ["Review the changed files.", "Run a relevant command profile if one exists.", "Commit only when you are ready to keep the branch."];
  }

  if (session.status === "completed") {
    return ["Open a PR or merge the session branch.", "Groveyard will retire the session after it lands in an auto-clean branch."];
  }

  if (changedFiles.length > 0) {
    return ["Open a PR or merge the session branch."];
  }

  return ["Continue the task in this session, or clean it if it is no longer needed."];
}

function printHandoffReport(report: HandoffReport): void {
  console.log(style("Handoff report", "bold"));
  console.log(`${style("Session", "cyan")}: ${report.session.id}`);
  console.log(`${style("Task", "cyan")}: ${report.session.taskName}`);
  console.log(`${style("State", "cyan")}: ${style(report.state.label, report.state.color)} ${style(`(${report.state.summary})`, "dim")}`);
  console.log(`${style("Branch", "cyan")}: ${report.session.branch}`);
  console.log(`${style("Base", "cyan")}: ${report.session.baseBranch}`);
  console.log(`${style("Worktree", "cyan")}: ${report.session.status === "cleaned" ? style("cleaned", "dim") : report.session.worktreePath}`);
  console.log("");

  console.log(style("Changed files", "bold"));
  if (report.changedFiles.length === 0) {
    console.log(`  ${style("none", "dim")}`);
  } else {
    for (const file of report.changedFiles.slice(0, 20)) {
      console.log(`  ${file}`);
    }

    if (report.changedFiles.length > 20) {
      console.log(`  ${style(`+${report.changedFiles.length - 20} more`, "dim")}`);
    }
  }

  console.log("");
  console.log(style("Contract", "bold"));
  console.log(`  ${report.contract.readyToCommit ? style("ready", "green") : style("needs attention", "yellow")}`);
  for (const action of report.contract.requiredActions) {
    console.log(`  ${style("-", "yellow")} ${action}`);
  }

  console.log("");
  console.log(style("Next", "bold"));
  for (const step of report.next) {
    console.log(`  ${style("-", "green")} ${step}`);
  }
}

function sessionStatusColor(status: SessionRecord["status"]): StyleColor {
  switch (status) {
    case "active":
      return "green";
    case "completed":
      return "cyan";
    case "failed":
      return "red";
    case "cleaned":
      return "dim";
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp(): void {
  printLogo();
  console.log(`Groveyard

Usage:
  groveyard                         Start the stdio MCP server
  groveyard init [--repo PATH]      Create .groveyard.yml
  groveyard doctor [--repo PATH]    Check repo/config readiness
  groveyard connect [--repo PATH]   Detect agent configs and connect MCP
  groveyard dashboard [--repo PATH] Overview repo, MCP config, and sessions
  groveyard sessions [--repo PATH]  List registered sessions
  groveyard inspect <sessionId>     Show session metadata and status
  groveyard commit <sessionId> -m "message"
  groveyard clean <sessionId>       Remove a registered session worktree

Options:
  --repo PATH   Path inside the Git repository
  --json        Print JSON output for CLI commands
  --plain       Print non-interactive session rows for sessions
  --force       Overwrite files for commands that support it
  --yes, -y     Confirm prompts for commands that support it
`);
}

async function buildDashboardReport(service: WorktreeSessionService, args: ParsedArgs): Promise<DashboardReport> {
  const repoRoot = await resolveRepoRoot(resolve(args.repoPath ?? process.cwd()));
  const [config, branch, baseStatus, rows] = await Promise.all([
    loadConfig(repoRoot),
    getCurrentBranch(repoRoot),
    gitStatusShort(repoRoot),
    service.listSessions(repoRoot),
  ]);
  const sessionItems = await Promise.all(rows.map((session) => summarizeSession(service, repoRoot, session)));
  const configPath = resolve(repoRoot, ".groveyard.yml");
  const configExists = existsSync(configPath);
  const targets = await summarizeMcpTargets(detectAgentConfigTargets());
  const active = sessionItems.filter((session) => session.status === "active");
  const dirty = active.filter((session) => session.dirty === true);
  const clean = active.filter((session) => session.dirty === false);
  const unknown = active.filter((session) => session.dirty === null);

  return {
    status: "ok",
    repoRoot,
    branch,
    base: {
      dirty: baseStatus.length > 0,
      changedFiles: countStatusLines(baseStatus),
      statusText: baseStatus,
    },
    configPath,
    configExists,
    config: {
      worktreesRoot: config.worktreesRoot,
      branchPrefix: config.branchPrefix,
      allowDirtyBase: config.allowDirtyBase,
      commandProfiles: Object.keys(config.commands),
    },
    sessions: {
      total: sessionItems.length,
      active: active.length,
      cleaned: sessionItems.filter((session) => session.status === "cleaned").length,
      dirty: dirty.length,
      clean: clean.length,
      unknown: unknown.length,
      items: sessionItems,
    },
    mcpConfigs: {
      detected: targets.filter((target) => target.detected).length,
      configured: targets.filter((target) => target.configured).length,
      targets,
    },
    next: dashboardNextSteps({
      configExists,
      connected: targets.some((target) => target.configured),
      activeSessions: active,
    }),
  };
}

async function summarizeSession(service: WorktreeSessionService, repoRoot: string, session: SessionRecord): Promise<DashboardSession> {
  if (session.status !== "active") {
    return {
      id: session.id,
      taskName: session.taskName,
      branch: session.branch,
      status: session.status,
      worktreePath: session.worktreePath,
      updatedAt: session.updatedAt,
      dirty: null,
      changedFiles: 0,
      statusText: "",
    };
  }

  try {
    const status = await service.gitStatus({ repoPath: repoRoot, sessionId: session.id });

    return {
      id: session.id,
      taskName: session.taskName,
      branch: session.branch,
      status: session.status,
      worktreePath: session.worktreePath,
      updatedAt: session.updatedAt,
      dirty: status.status.length > 0,
      changedFiles: countStatusLines(status.status),
      statusText: status.status,
    };
  } catch (error) {
    return {
      id: session.id,
      taskName: session.taskName,
      branch: session.branch,
      status: session.status,
      worktreePath: session.worktreePath,
      updatedAt: session.updatedAt,
      dirty: null,
      changedFiles: 0,
      statusText: "",
      statusError: error instanceof Error ? error.message : String(error),
    };
  }
}

function printDashboard(report: DashboardReport): void {
  const ready = !report.base.dirty && report.sessions.unknown === 0;
  const connectedTargets = report.mcpConfigs.targets.filter((target) => target.configured).map((target) => target.name);
  const commandProfiles = report.config.commandProfiles.length ? report.config.commandProfiles.map((name) => style(name, "green")).join(", ") : style("none", "dim");

  console.log(`${style("State", "bold")}: ${style(ready ? "ready" : "needs attention", ready ? "green" : "yellow")}`);
  console.log(`${style("Repo", "cyan")}: ${report.repoRoot}`);
  console.log(`${style("Branch", "cyan")}: ${report.branch}`);
  console.log(`${style("Base", "cyan")}: ${report.base.dirty ? style(`${report.base.changedFiles} changed`, "yellow") : style("clean", "green")}`);
  console.log(`${style("Config", "cyan")}: ${report.configExists ? report.configPath : style("defaults", "dim")}`);
  console.log(`${style("Profiles", "cyan")}: ${commandProfiles}`);
  console.log(`${style("MCP config", "cyan")}: ${connectedTargets.length ? style(connectedTargets.join(", "), "green") : style("not connected", "yellow")}`);
  console.log("");

  console.log(style("Sessions", "bold"));
  console.log(
    [
      `${style(String(report.sessions.active), "green")} active`,
      `${style(String(report.sessions.dirty), report.sessions.dirty > 0 ? "yellow" : "green")} dirty`,
      `${style(String(report.sessions.clean), "green")} clean`,
      `${style(String(report.sessions.cleaned), "dim")} cleaned`,
    ].join("  "),
  );

  if (report.sessions.items.length === 0) {
    console.log(style("No sessions yet.", "dim"));
  } else {
    for (const session of report.sessions.items.slice(0, 6)) {
      console.log(formatDashboardSessionLine(session));
    }

    if (report.sessions.items.length > 6) {
      console.log(style(`+${report.sessions.items.length - 6} more sessions`, "dim"));
    }
  }

  console.log("");
  console.log(style("Next", "bold"));
  for (const step of report.next) {
    console.log(`  ${style(step, "green")}`);
  }
}

async function summarizeMcpTargets(targets: AgentConfigTarget[]): Promise<DashboardMcpTarget[]> {
  return Promise.all(
    targets.map(async (target) => {
      if (!target.exists) {
        return {
          ...target,
          configured: false,
        };
      }

      try {
        const content = await readFile(target.path, "utf8");
        return {
          ...target,
          configured: hasGroveyardMcpConfig(target, content),
        };
      } catch (error) {
        return {
          ...target,
          configured: false,
          configError: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

function hasGroveyardMcpConfig(target: AgentConfigTarget, content: string): boolean {
  if (target.format === "toml") {
    return /\[mcp_servers\.groveyard\]/.test(content);
  }

  try {
    const parsed = JSON.parse(content) as { mcpServers?: Record<string, unknown> };
    return Boolean(parsed.mcpServers?.groveyard);
  } catch {
    return /"groveyard"\s*:/.test(content);
  }
}

function formatDashboardSessionLine(session: DashboardSession): string {
  const health = dashboardSessionHealth(session);
  const task = session.taskName.length > 44 ? `${session.taskName.slice(0, 41)}...` : session.taskName;

  return `  ${style(session.id.padEnd(28), "cyan")} ${style(health.label.padEnd(12), health.color)} ${task.padEnd(46)} ${style(session.branch, "dim")}`;
}

function dashboardSessionHealth(session: DashboardSession): { label: string; color: StyleColor } {
  if (session.status !== "active") {
    return {
      label: session.status,
      color: "dim",
    };
  }

  if (session.dirty === null) {
    return {
      label: "unknown",
      color: "red",
    };
  }

  if (session.dirty) {
    return {
      label: `${session.changedFiles} changed`,
      color: "yellow",
    };
  }

  return {
    label: "clean",
    color: "green",
  };
}

function dashboardNextSteps(input: { configExists: boolean; connected: boolean; activeSessions: DashboardSession[] }): string[] {
  const steps: string[] = [];

  if (!input.configExists) {
    steps.push("groveyard init");
  }

  if (!input.connected) {
    steps.push("groveyard connect");
  }

  if (input.activeSessions.length > 0) {
    steps.push(`groveyard inspect ${input.activeSessions[input.activeSessions.length - 1]!.id}`);
  } else {
    steps.push("Create a session from your MCP-capable coding agent");
  }

  return steps;
}

function countStatusLines(status: string): number {
  return status.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

function printLogo(): void {
  for (const line of groveyardAscii.split("\n")) {
    console.log(formatLogoLine(line));
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

function createConnectSnippets(repoRoot: string): ConnectSnippets {
  const agentInstructions = createAgentInstructionReference(repoRoot);
  const args = ["-y", "@groveyard/mcp"];
  const jsonConfig = {
    mcpServers: {
      groveyard: {
        command: "npx",
        args,
        env: {
          GROVEYARD_REPO: repoRoot,
          GROVEYARD_AGENT_INSTRUCTIONS: agentInstructions.path,
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
      `GROVEYARD_AGENT_INSTRUCTIONS = ${JSON.stringify(agentInstructions.path)}`,
    ].join("\n"),
    mcpJson: JSON.stringify(jsonConfig, null, 2),
    agentInstructionsPath: agentInstructions.path,
    agentInstructionText: agentInstructions.text,
  };
}

function createAgentInstructionReference(repoRoot: string): { path: string; text: string } {
  const path = join(repoRoot, agentInstructionsPath);

  return {
    path,
    text: `Before code-changing tasks in this repository, read and follow ${path}.`,
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
  const agentInstructions = createAgentInstructionReference(repoRoot);
  const block = [
    "[mcp_servers.groveyard]",
    'command = "npx"',
    'args = ["-y", "@groveyard/mcp"]',
    "",
    "[mcp_servers.groveyard.env]",
    `GROVEYARD_REPO = ${JSON.stringify(repoRoot)}`,
    `GROVEYARD_AGENT_INSTRUCTIONS = ${JSON.stringify(agentInstructions.path)}`,
  ].join("\n");

  const pattern = /\n?\[mcp_servers\.groveyard\][\s\S]*?(?=\n\[mcp_servers\.|\n\[[^\]]+\]|\s*$)/;
  const trimmed = existing.trimEnd();

  if (pattern.test(trimmed)) {
    return `${trimmed.replace(pattern, `\n${block}`)}\n`;
  }

  return `${trimmed ? `${trimmed}\n\n` : ""}${block}\n`;
}

function upsertMcpJson(existing: string, repoRoot: string): string {
  const agentInstructions = createAgentInstructionReference(repoRoot);
  const config = existing.trim() ? (JSON.parse(existing) as { mcpServers?: Record<string, unknown> }) : {};
  config.mcpServers = {
    ...config.mcpServers,
    groveyard: {
      command: "npx",
      args: ["-y", "@groveyard/mcp"],
      env: {
        GROVEYARD_REPO: repoRoot,
        GROVEYARD_AGENT_INSTRUCTIONS: agentInstructions.path,
      },
    },
  };

  return `${JSON.stringify(config, null, 2)}\n`;
}

function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY && !process.env.CI);
}

function style(value: string, color: StyleColor): string {
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

function formatLogoLine(line: string): string {
  if (!process.stdout.isTTY || process.env.NO_COLOR) {
    return line;
  }

  const firstBreak = Math.max(1, Math.floor(line.length * 0.34));
  const secondBreak = Math.max(firstBreak + 1, Math.floor(line.length * 0.68));
  const visible = line.trimEnd().length;
  const redAccent = Math.max(0, visible - 2);

  return Array.from(line)
    .map((character, index) => {
      if (character === " ") {
        return character;
      }

      if (visible >= 12 && index >= redAccent) {
        return truecolor(character, 255, 94, 87);
      }

      if (index >= secondBreak) {
        return truecolor(character, 186, 255, 208);
      }

      if (index >= firstBreak) {
        return truecolor(character, 114, 255, 168);
      }

      return truecolor(character, 76, 255, 146);
    })
    .join("");
}

function truecolor(value: string, red: number, green: number, blue: number): string {
  return `\x1b[38;2;${red};${green};${blue}m${value}\x1b[39m`;
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
  const lines = [
    "worktreesRoot: .agent-worktrees",
    "branchPrefix: agent/",
    "allowDirtyBase: false",
    "autoCleanBranches:",
    "  - main",
    "  - master",
    "  - dev",
    "  - develop",
    "commands:",
  ];
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

async function writeAgentInstructions(repoRoot: string): Promise<{ path: string }> {
  const outputPath = join(repoRoot, agentInstructionsPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderAgentInstructions("code-changing tasks in this repository"), "utf8");

  return {
    path: outputPath,
  };
}

async function ensureGroveyardGitignore(repoRoot: string): Promise<{ path: string; added: string[]; entries: string[] }> {
  const gitignorePath = join(repoRoot, ".gitignore");
  const existing = existsSync(gitignorePath) ? await readFile(gitignorePath, "utf8") : "";
  const existingKeys = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => normalizeGitignoreEntry(line))
      .filter((line) => line.length > 0),
  );
  const added = groveyardIgnoreEntries.filter((entry) => !existingKeys.has(normalizeGitignoreEntry(entry)));

  if (added.length > 0) {
    const prefix = existing.trimEnd();
    await writeFile(gitignorePath, `${prefix}${prefix ? "\n\n" : ""}# Groveyard\n${added.join("\n")}\n`, "utf8");
  }

  return {
    path: gitignorePath,
    added,
    entries: groveyardIgnoreEntries,
  };
}

function normalizeGitignoreEntry(value: string): string {
  const trimmed = value.trim();

  if (!trimmed || trimmed.startsWith("#")) {
    return "";
  }

  return trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
}
