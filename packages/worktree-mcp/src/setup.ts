import { constants, existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  choosePrimaryClient,
  classifyEnvironment,
  detectClients,
  getClientAdapters,
  instructionTargetPaths,
  installInstructionTargets,
  managedInstructionState,
  validateInstructionTargets,
  type ClientAdapter,
  type ClientId,
  type ClientSetupResult,
  type InstructionResult,
  type ManualInstructions,
  type SetupContext,
  type SetupEnvironment,
} from "./client-adapters.js";
import { loadConfig, type WorktreeMcpConfig } from "./config.js";
import {
  GitCommandError,
  commitSpecificPaths,
  getCurrentBranch,
  getCurrentBranchOrUnborn,
  getRefSha,
  gitStatusShort,
  listCommitPaths,
  parseWorktreeListPorcelain,
  readGitIdentity,
  resolveRepoRoot,
  runGit,
} from "./git.js";
import { createMcpServer, renderAgentInstructions } from "./mcp-server.js";
import { JsonSessionStore } from "./session-store.js";

export type SetupStatus = "ready" | "manual_connection_required" | "commit_required" | "error";

export type SetupCheck = {
  id: string;
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
  fix?: string;
};

export type SetupOptions = {
  repoPath?: string;
  name?: string;
  clients?: ClientId[];
  all?: boolean;
  yes?: boolean;
  json?: boolean;
  force?: boolean;
  configPath?: string;
  noInstructions?: boolean;
  noCommit?: boolean;
};

export type SetupReport = {
  status: SetupStatus;
  repoRoot: string;
  environment: SetupEnvironment;
  initialization: {
    config: "created" | "regenerated" | "preserved";
    agentInstructions: "created" | "updated" | "unchanged";
    gitignoreEntriesAdded: string[];
  };
  commit: {
    action: "created" | "unchanged" | "skipped" | "failed";
    sha?: string;
    message?: string;
    files: string[];
  };
  readiness: {
    ok: boolean;
    checks: SetupCheck[];
  };
  connection: {
    serverName: string;
    selectedClientIds: ClientId[];
    targets: ClientSetupResult[];
    instructions: InstructionResult[];
    manualConfigs: ManualInstructions[];
    otherDetectedClients: Array<{ id: ClientId; name: string }>;
    codexToml: string;
    mcpJson: string;
  };
  nextSteps: string[];
  error?: string;
};

const configFileName = ".groveyard.yml";
const agentContractRelativePath = join(".groveyard", "AGENTS.md");
const ignoreEntries = [".agent-worktrees/", ".groveyard/"];
const setupCommitMessage = "chore: configure Groveyard";

export async function setupGroveyard(options: SetupOptions): Promise<SetupReport> {
  const environment = classifyEnvironment();
  const requestedPath = resolve(options.repoPath ?? process.cwd());
  let repoRoot = requestedPath;
  let serverName = "groveyard";
  const initialization = {
    config: "preserved" as const,
    agentInstructions: "unchanged" as const,
    gitignoreEntriesAdded: [],
  };
  const emptyCommit = { action: "unchanged" as const, files: [] as string[] };

  try {
    repoRoot = await resolveRepoRoot(requestedPath);
    serverName = resolveServerName(repoRoot, options.name);
    const configPath = join(repoRoot, configFileName);
    const context: SetupContext = {
      repoRoot,
      serverName,
      agentInstructionsPath: join(repoRoot, agentContractRelativePath),
      environment,
      genericConfigPath: options.configPath ? resolve(options.configPath) : undefined,
      noInstructions: options.noInstructions,
    };

    // Existing user configuration is validated before setup writes anything.
    if (existsSync(configPath) && !options.force) await loadConfig(repoRoot);
    const detected = await detectClients(context);
    const selected = selectAdapters(detected, options);
    await validateInstructionTargets(context, selected);

    const preflight = await Promise.all(selected.map(async (adapter) => ({ adapter, state: await adapter.inspect(context) })));
    const malformed = new Map(preflight.filter((item) => !item.state.valid).map((item) => [item.adapter.id, item.state.error ?? "Malformed configuration."]));
    await requireCleanSetupBranch(repoRoot);
    await readGitIdentity(repoRoot);
    await getCurrentBranchOrUnborn(repoRoot);

    const repositoryWrite = await initializeRepository(repoRoot, context, selected, Boolean(options.force));
    const commitFiles = repositoryWrite.commitFiles;
    const commit = await commitRepositorySetup(repoRoot, commitFiles, Boolean(options.noCommit));
    const instructions = repositoryWrite.instructions;

    const readiness = await runRepositoryChecks(repoRoot, await loadConfig(repoRoot));
    if (commit.action === "failed") {
      return errorReport(repoRoot, environment, serverName, repositoryWrite.initialization, commit, readiness, commit.message ?? "Failed to create the setup commit.");
    }

    if (commit.action === "skipped" && commit.files.length > 0) {
      return {
        status: "commit_required",
        repoRoot,
        environment,
        initialization: repositoryWrite.initialization,
        commit,
        readiness,
        connection: {
          serverName,
          selectedClientIds: selected.map((adapter) => adapter.id),
          targets: [],
          instructions,
          manualConfigs: selected.length > 0 ? selected.map((adapter) => adapter.renderManualInstructions(context)) : manualDefaults().map((adapter) => adapter.renderManualInstructions(context)),
          otherDetectedClients: detected
            .filter((item) => item.detection.detected && !selected.some((adapter) => adapter.id === item.adapter.id) && item.adapter.id !== "generic")
            .map((item) => ({ id: item.adapter.id, name: item.adapter.name })),
          codexToml: getClientAdapters().find((adapter) => adapter.id === "codex")!.renderManualInstructions(context).content,
          mcpJson: getClientAdapters().find((adapter) => adapter.id === "generic")!.renderManualInstructions(context).content,
        },
        nextSteps: [`Commit the generated files with: git add -- ${commit.files.join(" ")} && git commit -m "${setupCommitMessage}"`, "Run groveyard setup again after the commit."],
      };
    }

    const targets: ClientSetupResult[] = [];

    for (const adapter of selected) {
      if (malformed.has(adapter.id)) {
        const detection = detected.find((item) => item.adapter.id === adapter.id)?.detection ?? (await adapter.detect(context));
        targets.push({
          id: adapter.id,
          name: adapter.name,
          detected: detection.detected,
          detectedBy: detection.detectedBy,
          method: "manual",
          scope: "personal-repo",
          configPath: detection.configPath,
          action: "manual",
          verified: false,
          error: `${malformed.get(adapter.id)} Groveyard left the file unchanged.`,
        });
        continue;
      }

      const installed = await adapter.install(context);
      if (installed.action === "created" || installed.action === "updated" || installed.action === "unchanged") {
        const verification = await adapter.verify(context);
        targets.push({
          ...installed,
          verified: verification.verified,
          action: verification.verified ? installed.action : "failed",
          error: verification.verified ? installed.error : verification.detail,
        });
      } else {
        targets.push(installed);
      }
    }

    const failed = targets.some((target) => target.action === "failed");
    const verified = targets.filter((target) => target.verified);
    const status: SetupStatus = failed ? "error" : verified.length > 0 && readiness.ok ? "ready" : "manual_connection_required";
    const selectedIds = selected.map((adapter) => adapter.id);
    const otherDetectedClients = detected
      .filter((item) => item.detection.detected && !selectedIds.includes(item.adapter.id) && item.adapter.id !== "generic")
      .map((item) => ({ id: item.adapter.id, name: item.adapter.name }));
    const manualAdapters = selected.length > 0 ? selected.filter((adapter) => !targets.some((target) => target.id === adapter.id && target.verified)) : manualDefaults();
    const manualConfigs = manualAdapters.map((adapter) => adapter.renderManualInstructions(context));
    const codexToml = getClientAdapters().find((adapter) => adapter.id === "codex")!.renderManualInstructions(context).content;
    const mcpJson = getClientAdapters().find((adapter) => adapter.id === "generic")!.renderManualInstructions(context).content;

    return {
      status,
      repoRoot,
      environment,
      initialization: repositoryWrite.initialization,
      commit,
      readiness,
      connection: {
        serverName,
        selectedClientIds: selectedIds,
        targets,
        instructions,
        manualConfigs,
        otherDetectedClients,
        codexToml,
        mcpJson,
      },
      nextSteps: setupNextSteps(status, verified, otherDetectedClients),
      error: failed ? targets.find((target) => target.action === "failed")?.error : undefined,
    };
  } catch (error) {
    return errorReport(
      repoRoot,
      environment,
      serverName,
      initialization,
      emptyCommit,
      { ok: false, checks: [] },
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function listClientDetection(options: Pick<SetupOptions, "repoPath" | "name" | "configPath">): Promise<{
  repoRoot: string;
  environment: SetupEnvironment;
  clients: Array<{ id: ClientId; name: string; detected: boolean; detectedBy: string[]; selected: boolean }>;
}> {
  const repoRoot = await resolveRepoRoot(resolve(options.repoPath ?? process.cwd()));
  const environment = classifyEnvironment();
  const context: SetupContext = {
    repoRoot,
    serverName: resolveServerName(repoRoot, options.name),
    agentInstructionsPath: join(repoRoot, agentContractRelativePath),
    environment,
    genericConfigPath: options.configPath ? resolve(options.configPath) : undefined,
  };
  const detected = await detectClients(context);
  const selected = choosePrimaryClient(detected);
  return {
    repoRoot,
    environment,
    clients: detected.map((item) => ({
      id: item.adapter.id,
      name: item.adapter.name,
      detected: item.detection.detected,
      detectedBy: item.detection.detectedBy,
      selected: item.adapter.id === selected?.id,
    })),
  };
}

async function initializeRepository(
  repoRoot: string,
  context: SetupContext,
  selected: ClientAdapter[],
  force: boolean,
): Promise<{
  initialization: SetupReport["initialization"];
  instructions: InstructionResult[];
  commitFiles: string[];
}> {
  const configPath = join(repoRoot, configFileName);
  const configExists = existsSync(configPath);
  let configAction: SetupReport["initialization"]["config"] = "preserved";
  const commitFiles = new Set<string>();

  if (!configExists || force) {
    const commands = await detectCommandProfiles(repoRoot);
    const next = renderConfig(commands);
    const existing = configExists ? await readFile(configPath, "utf8") : undefined;
    if (existing !== next) {
      await atomicWrite(configPath, next);
      commitFiles.add(configFileName);
    }
    configAction = configExists ? "regenerated" : "created";
  }

  const agentInstructions = await writeIfChanged(join(repoRoot, agentContractRelativePath), `${renderAgentInstructions()}\n`);
  const gitignoreEntriesAdded = await ensureGitignore(repoRoot);
  if (gitignoreEntriesAdded.length > 0) commitFiles.add(".gitignore");
  const instructions = await installInstructionTargets(context, selected);
  for (const instruction of instructions) {
    if (instruction.action !== "unchanged") commitFiles.add(relative(repoRoot, instruction.path));
  }
  return {
    initialization: { config: configAction, agentInstructions, gitignoreEntriesAdded },
    instructions,
    commitFiles: [...commitFiles].sort(),
  };
}

export async function runRepositoryChecks(repoRoot: string, config: WorktreeMcpConfig): Promise<SetupReport["readiness"]> {
  const checks: SetupCheck[] = [];
  const add = (check: SetupCheck): void => { checks.push(check); };

  add({ id: "repository", name: "Repository", ok: true, required: true, detail: repoRoot });

  try {
    const branch = await getCurrentBranchOrUnborn(repoRoot);
    add({ id: "base-ref", name: "Current branch", ok: true, required: true, detail: branch });
  } catch (error) {
    add({ id: "base-ref", name: "Current branch", ok: false, required: true, detail: errorMessage(error), fix: "Create or check out a Git branch." });
  }

  add({ id: "config", name: "Groveyard configuration", ok: true, required: true, detail: `${configFileName} parses successfully` });

  const worktreeRoot = resolve(repoRoot, config.worktreesRoot);
  const relativeRoot = relative(repoRoot, worktreeRoot);
  const rootSafe = !isAbsolute(relativeRoot) && relativeRoot !== ".." && !relativeRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
  add({
    id: "worktree-root",
    name: "Managed workspace root",
    ok: rootSafe,
    required: true,
    detail: worktreeRoot,
    fix: rootSafe ? undefined : "Set worktreesRoot to a path inside the repository.",
  });

  if (rootSafe) {
    try {
      const parent = await nearestExistingParent(worktreeRoot);
      await access(parent, constants.W_OK);
      add({ id: "worktree-writable", name: "Workspace parent writable", ok: true, required: true, detail: parent });
    } catch (error) {
      add({ id: "worktree-writable", name: "Workspace parent writable", ok: false, required: true, detail: errorMessage(error), fix: "Choose a writable worktreesRoot." });
    }
  }

  try {
    await runGit(repoRoot, ["worktree", "list", "--porcelain"]);
    add({ id: "git-worktrees", name: "Git worktree support", ok: true, required: true, detail: "git worktree list succeeded" });
  } catch (error) {
    add({ id: "git-worktrees", name: "Git worktree support", ok: false, required: true, detail: errorMessage(error), fix: "Install a Git version with worktree support." });
  }

  const contractPath = join(repoRoot, agentContractRelativePath);
  try {
    await access(contractPath, constants.R_OK);
    add({ id: "agent-contract", name: "Agent contract", ok: true, required: true, detail: contractPath });
  } catch {
    add({ id: "agent-contract", name: "Agent contract", ok: false, required: true, detail: contractPath, fix: "Run groveyard setup again." });
  }

  const outdatedInstructionFiles: string[] = [];
  for (const relativePath of instructionTargetPaths()) {
    const path = join(repoRoot, relativePath);
    const content = await readOptional(path);
    if (content && managedInstructionState(content) === "outdated") outdatedInstructionFiles.push(relativePath);
  }
  add({
    id: "instruction-version",
    name: "Native instruction blocks",
    ok: outdatedInstructionFiles.length === 0,
    required: true,
    detail: outdatedInstructionFiles.length === 0
      ? "Groveyard session-continuity instructions are current"
      : `Groveyard session-continuity instructions are outdated in ${outdatedInstructionFiles.join(", ")}.`,
    fix: outdatedInstructionFiles.length === 0 ? undefined : "Run groveyard setup to update them.",
  });

  const gitignore = await readOptional(join(repoRoot, ".gitignore"));
  const missingIgnores = ignoreEntries.filter((entry) => !hasIgnoreEntry(gitignore ?? "", entry));
  add({
    id: "gitignore",
    name: "Generated file ignores",
    ok: missingIgnores.length === 0,
    required: true,
    detail: missingIgnores.length === 0 ? "required entries are present" : `missing ${missingIgnores.join(", ")}`,
    fix: missingIgnores.length ? "Run groveyard setup again." : undefined,
  });

  const status = await gitStatusShort(repoRoot);
  add({
    id: "base-cleanliness",
    name: "Base checkout cleanliness",
    ok: status.length === 0,
    required: true,
    detail: status.length === 0 ? "clean" : `${status.split(/\r?\n/).filter(Boolean).length} changed file(s)`,
    fix: status.length === 0 ? undefined : "Commit or stash the current checkout before running start_session.",
  });

  const sessionStoreDirectory = join(repoRoot, ".groveyard");
  try {
    const writableParent = await nearestExistingParent(sessionStoreDirectory);
    await access(writableParent, constants.W_OK);
    add({ id: "session-store", name: "Session store", ok: true, required: true, detail: sessionStoreDirectory });
  } catch (error) {
    add({ id: "session-store", name: "Session store", ok: false, required: true, detail: errorMessage(error), fix: "Make .groveyard writable." });
  }

  try {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: "groveyard-doctor", version: "1.0.0" }, { capabilities: {} });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    const hasStartSession = tools.tools.some((tool) => tool.name === "start_session");
    add({
      id: "mcp-handshake",
      name: "MCP handshake",
      ok: hasStartSession,
      required: true,
      detail: hasStartSession ? `server initialized with ${tools.tools.length} tools` : "start_session was not advertised",
      fix: hasStartSession ? undefined : "Reinstall the current Groveyard package.",
    });
    await clientTransport.close();
    await serverTransport.close();
  } catch (error) {
    add({ id: "mcp-handshake", name: "MCP handshake", ok: false, required: true, detail: errorMessage(error), fix: "Reinstall Groveyard and run setup again." });
  }

  try {
    const worktrees = parseWorktreeListPorcelain(await runGit(repoRoot, ["worktree", "list", "--porcelain"]));
    const sessions = await new JsonSessionStore(join(repoRoot, ".groveyard", "sessions.json")).list();
    const managedRoot = resolve(repoRoot, config.worktreesRoot);
    const registered = new Set(sessions.filter((session) => session.status !== "cleaned" && session.status !== "released").map((session) => resolve(session.worktreePath)));
    const orphaned = worktrees.filter((worktree) => resolve(worktree.path).startsWith(`${managedRoot}${process.platform === "win32" ? "\\" : "/"}`) && !registered.has(resolve(worktree.path)));
    const stale = sessions.filter((session) => session.status === "active" && !existsSync(session.worktreePath));
    add({
      id: "session-reconciliation",
      name: "Session reconciliation",
      ok: orphaned.length === 0 && stale.length === 0,
      required: false,
      detail: orphaned.length || stale.length ? `${orphaned.length} orphaned worktree(s), ${stale.length} stale session(s)` : "no orphaned worktrees or stale sessions",
      fix: orphaned.length || stale.length ? "Inspect groveyard sessions and git worktree list before cleaning stale entries." : undefined,
    });
  } catch (error) {
    add({ id: "session-reconciliation", name: "Session reconciliation", ok: false, required: false, detail: errorMessage(error), fix: "Inspect .groveyard/sessions.json and git worktree list." });
  }

  return { ok: checks.every((check) => !check.required || check.ok), checks };
}

function selectAdapters(
  detected: Array<{ adapter: ClientAdapter; detection: { detected: boolean } }>,
  options: SetupOptions,
): ClientAdapter[] {
  const adapters = getClientAdapters();
  const requested = [...new Set(options.clients ?? [])];

  if (options.configPath && requested.length === 0) requested.push("generic");
  if (requested.length > 0) {
    return requested.map((id) => {
      const adapter = adapters.find((candidate) => candidate.id === id);
      if (!adapter) throw new Error(`Unsupported client ID: ${id}`);
      if (id === "generic" && !options.configPath) throw new Error("--client generic requires --config PATH.");
      return adapter;
    });
  }

  if (options.all) return detected.filter((item) => item.detection.detected && item.adapter.id !== "generic").map((item) => item.adapter);
  const primary = choosePrimaryClient(detected as Array<{ adapter: ClientAdapter; detection: any }>);
  return primary ? [primary] : [];
}

function manualDefaults(): ClientAdapter[] {
  const adapters = getClientAdapters();
  return ["codex", "vscode", "generic"].map((id) => adapters.find((adapter) => adapter.id === id)!).filter(Boolean);
}

function setupNextSteps(
  status: SetupStatus,
  verified: ClientSetupResult[],
  others: Array<{ id: ClientId; name: string }>,
): string[] {
  if (status === "error") return ["Fix the failed check, then run groveyard setup again."];
  if (status === "commit_required") return ["Create the setup commit, then rerun groveyard setup."];
  if (status === "manual_connection_required") {
    return ["Add one of the provided MCP configurations in the coding app that runs on this filesystem.", "Restart the app and run groveyard doctor."];
  }

  const names = verified.map((target) => target.name).join(", ");
  const steps = [`Restart ${names} so it reloads MCP configuration.`, "Ask your agent to implement a task."];
  if (others.length > 0) steps.push(`Configure other detected clients with groveyard setup --client ${others[0]!.id} or groveyard setup --all.`);
  return steps;
}

function errorReport(
  repoRoot: string,
  environment: SetupEnvironment,
  serverName: string,
  initialization: SetupReport["initialization"],
  commit: SetupReport["commit"],
  readiness: SetupReport["readiness"],
  error: string,
): SetupReport {
  return {
    status: "error",
    repoRoot,
    environment,
    initialization,
    commit,
    readiness,
    connection: {
      serverName,
      selectedClientIds: [],
      targets: [],
      instructions: [],
      manualConfigs: [],
      otherDetectedClients: [],
      codexToml: "",
      mcpJson: "",
    },
    nextSteps: ["Fix the reported error, then run groveyard setup again."],
    error,
  };
}

function resolveServerName(repoRoot: string, explicit: string | undefined): string {
  const value = explicit ?? `groveyard_${basename(repoRoot).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "repo"}`;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("MCP server name may contain only letters, numbers, underscores, and hyphens.");
  return value;
}

async function requireCleanSetupBranch(repoRoot: string): Promise<void> {
  const status = await gitStatusShort(repoRoot);
  if (!status) return;
  throw new Error(`Repository has uncommitted or staged changes. Commit or stash them before running setup:\n${status}`);
}

async function commitRepositorySetup(
  repoRoot: string,
  files: string[],
  noCommit: boolean,
): Promise<SetupReport["commit"]> {
  if (files.length === 0) {
    return { action: "unchanged", files: [] };
  }

  if (noCommit) {
    return { action: "skipped", message: setupCommitMessage, files };
  }

  try {
    const commit = await commitSpecificPaths(repoRoot, files, setupCommitMessage);
    const committedFiles = await listCommitPaths(repoRoot, commit.sha);
    const expected = new Set(files);
    const actual = new Set(committedFiles);
    if (committedFiles.length !== files.length || files.some((file) => !actual.has(file))) {
      throw new Error(`Setup commit ${commit.sha} did not contain the expected files.`);
    }
    await getRefSha(repoRoot, "HEAD");
    const status = await gitStatusShort(repoRoot);
    if (status) {
      throw new Error(`Setup commit ${commit.sha} succeeded, but the checkout is not clean:\n${status}`);
    }
    return { action: "created", sha: commit.sha, message: commit.message, files: [...expected] };
  } catch (error) {
    const details = error instanceof GitCommandError && error.output ? `\n${error.output}` : "";
    return {
      action: "failed",
      message: `${error instanceof Error ? error.message : String(error)}${details}`,
      files,
    };
  }
}

async function detectCommandProfiles(repoRoot: string): Promise<Record<string, string>> {
  try {
    const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    const scripts = packageJson.scripts ?? {};
    const commands: Record<string, string> = {};
    for (const name of ["test", "typecheck", "lint", "build"]) {
      if (scripts[name]) commands[name] = `npm run ${name}`;
    }
    return commands;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    throw error;
  }
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
  if (entries.length === 0) lines[lines.length - 1] = "commands: {}";
  else for (const [name, command] of entries) lines.push(`  ${name}: ${JSON.stringify(command)}`);
  return `${lines.join("\n")}\n`;
}

async function ensureGitignore(repoRoot: string): Promise<string[]> {
  const path = join(repoRoot, ".gitignore");
  const existing = (await readOptional(path)) ?? "";
  const added = ignoreEntries.filter((entry) => !hasIgnoreEntry(existing, entry));
  if (added.length === 0) return [];
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await atomicWrite(path, `${existing}${separator}${added.join("\n")}\n`);
  return added;
}

function hasIgnoreEntry(content: string, expected: string): boolean {
  const normalized = expected.replace(/\/$/, "");
  return content.split(/\r?\n/).map((line) => line.trim().replace(/^\//, "").replace(/\/$/, "")).includes(normalized);
}

async function writeIfChanged(path: string, content: string): Promise<"created" | "updated" | "unchanged"> {
  const existing = await readOptional(path);
  if (existing === content) return "unchanged";
  await atomicWrite(path, content);
  return existing === undefined ? "created" : "updated";
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, content, "utf8");
  await rename(temp, path);
}

async function nearestExistingParent(path: string): Promise<string> {
  let candidate = path;
  while (true) {
    try {
      const info = await stat(candidate);
      if (!info.isDirectory()) throw new Error(`${candidate} is not a directory.`);
      return candidate;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error; }
