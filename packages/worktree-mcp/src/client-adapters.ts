import { constants, existsSync, readFileSync } from "node:fs";
import { access, copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";

export type ClientId =
  | "codex"
  | "claude-code"
  | "vscode"
  | "cursor"
  | "gemini"
  | "opencode"
  | "claude-desktop"
  | "generic";

export type ClientAction = "created" | "updated" | "unchanged" | "skipped" | "manual" | "failed" | "removed";
export type ClientScope = "personal-repo";
export type ClientMethod = "config-file" | "manual";

export type SetupEnvironment = {
  kind: "local" | "ssh" | "wsl" | "dev-container" | "codespace" | "remote";
  label: string;
  evidence: string[];
  home: string;
};

export type SetupContext = {
  repoRoot: string;
  serverName: string;
  agentInstructionsPath: string;
  environment: SetupEnvironment;
  genericConfigPath?: string;
  noInstructions?: boolean;
};

export type ClientDetection = {
  detected: boolean;
  detectedBy: string[];
  configPath?: string;
  executable?: string;
};

export type ClientConfigState = {
  exists: boolean;
  valid: boolean;
  configured: boolean;
  content?: string;
  error?: string;
};

export type ClientSetupResult = {
  id: ClientId;
  name: string;
  detected: boolean;
  detectedBy: string[];
  method: ClientMethod;
  scope: ClientScope;
  configPath?: string;
  backupPath?: string;
  action: ClientAction;
  verified: boolean;
  error?: string;
};

export type ClientVerification = { verified: boolean; detail?: string };

export type ManualInstructions = {
  id: ClientId;
  format: "toml" | "json";
  content: string;
  instructions: string[];
};

export type InstructionTarget = {
  relativePath: string;
};

export type InstructionResult = {
  path: string;
  action: "created" | "updated" | "unchanged";
};

export type ClientAdapter = {
  id: ClientId;
  name: string;
  instructionFiles: InstructionTarget[];
  detect(context: SetupContext): Promise<ClientDetection>;
  inspect(context: SetupContext): Promise<ClientConfigState>;
  install(context: SetupContext): Promise<ClientSetupResult>;
  verify(context: SetupContext): Promise<ClientVerification>;
  uninstall(context: SetupContext): Promise<ClientSetupResult>;
  renderManualInstructions(context: SetupContext): ManualInstructions;
};

const managedStart = "<!-- groveyard:start -->";
const managedEnd = "<!-- groveyard:end -->";
const managedVersion = "1";

export const managedInstructionBlock = `${managedStart}
## Groveyard workspace policy

Before modifying files, start a Groveyard session for the task.
Work only in the workspace returned by Groveyard.
Validate the session before declaring the task complete.
Do not remove a dirty workspace without explicit user approval.
${managedEnd}`;

export function classifyEnvironment(env: NodeJS.ProcessEnv = process.env): SetupEnvironment {
  const evidence: string[] = [];
  const home = env.HOME ?? env.USERPROFILE ?? homedir();

  if (env.CODESPACES === "true" || env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN) {
    evidence.push("GitHub Codespaces environment");
    return { kind: "codespace", label: "Codespace", evidence, home };
  }

  if (env.REMOTE_CONTAINERS === "true" || env.DEVCONTAINER === "true" || existsSync("/.dockerenv")) {
    evidence.push("container environment");
    return { kind: "dev-container", label: "Dev Container", evidence, home };
  }

  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP || readProcVersion().toLowerCase().includes("microsoft")) {
    evidence.push("WSL environment");
    return { kind: "wsl", label: "WSL", evidence, home };
  }

  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) {
    evidence.push("SSH environment");
    return { kind: "ssh", label: "SSH", evidence, home };
  }

  if (env.REMOTE_HOST) {
    evidence.push("remote host environment");
    return { kind: "remote", label: "Remote", evidence, home };
  }

  return { kind: "local", label: "Local", evidence, home };
}

export function inferCurrentClientId(env: NodeJS.ProcessEnv = process.env): ClientId | undefined {
  const keys = Object.entries(env).filter(([, value]) => Boolean(value)).map(([key]) => key);
  const termProgram = env.TERM_PROGRAM?.toLowerCase() ?? "";

  if (keys.some((key) => key.startsWith("CODEX_"))) return "codex";
  if (keys.some((key) => key.startsWith("VSCODE_")) || termProgram === "vscode" || termProgram === "visual studio code") return "vscode";
  if (keys.some((key) => key.startsWith("CLAUDE_")) || keys.some((key) => key.startsWith("CLAUDECODE")) || termProgram.includes("claude")) return "claude-code";
  if (keys.some((key) => key.startsWith("CURSOR_")) || termProgram === "cursor") return "cursor";
  if (keys.some((key) => key.startsWith("GEMINI_")) || termProgram.includes("gemini")) return "gemini";
  if (keys.some((key) => key.startsWith("OPENCODE_")) || termProgram.includes("opencode")) return "opencode";
  return undefined;
}

export function getClientAdapters(): ClientAdapter[] {
  return [
    new CodexAdapter(),
    new ClaudeCodeAdapter(),
    new VscodeAdapter(),
    new JsonAdapter("cursor", "Cursor", cursorPath, "mcpServers", [{ relativePath: ".cursor/rules/groveyard.mdc" }]),
    new JsonAdapter("gemini", "Gemini CLI", geminiPath, "mcpServers", [{ relativePath: "GEMINI.md" }]),
    new OpenCodeAdapter(),
    new JsonAdapter("claude-desktop", "Claude Desktop", claudeDesktopPath, "mcpServers", []),
    new GenericAdapter(),
  ];
}

export async function detectClients(context: SetupContext): Promise<Array<{ adapter: ClientAdapter; detection: ClientDetection }>> {
  return Promise.all(getClientAdapters().map(async (adapter) => ({ adapter, detection: await adapter.detect(context) })));
}

export function choosePrimaryClient(
  detected: Array<{ adapter: ClientAdapter; detection: ClientDetection }>,
  env: NodeJS.ProcessEnv = process.env,
): ClientAdapter | undefined {
  const available = detected.filter((item) => item.detection.detected && item.adapter.id !== "generic");
  const current = inferCurrentClientId(env);
  const currentAdapter = current ? available.find((item) => item.adapter.id === current)?.adapter : undefined;
  if (currentAdapter) return currentAdapter;
  if (available.length === 1) return available[0]?.adapter;

  const scored = available
    .map((item) => ({
      ...item,
      score:
        (item.detection.executable ? 20 : 0) +
        (item.detection.detectedBy.some((value) => value.includes("config file")) ? 10 : 0) +
        primaryTieBreak(item.adapter.id),
    }))
    .sort((left, right) => right.score - left.score);

  return scored[0]?.adapter;
}

export async function validateInstructionTargets(context: SetupContext, adapters: ClientAdapter[]): Promise<void> {
  if (context.noInstructions) return;

  for (const relativePath of new Set(adapters.flatMap((adapter) => adapter.instructionFiles.map((target) => target.relativePath)))) {
    const path = join(context.repoRoot, relativePath);
    const existing = await readOptional(path);
    if (existing === undefined) continue;
    validateManagedMarkers(existing, path);
  }
}

export async function installInstructionTargets(context: SetupContext, adapters: ClientAdapter[]): Promise<InstructionResult[]> {
  if (context.noInstructions) return [];

  const results: InstructionResult[] = [];
  for (const relativePath of new Set(adapters.flatMap((adapter) => adapter.instructionFiles.map((target) => target.relativePath)))) {
    const path = join(context.repoRoot, relativePath);
    results.push({ path, action: await writeManagedInstructions(path) });
  }
  return results;
}

abstract class BaseAdapter implements ClientAdapter {
  abstract id: ClientId;
  abstract name: string;
  abstract instructionFiles: InstructionTarget[];
  abstract detect(context: SetupContext): Promise<ClientDetection>;
  abstract inspect(context: SetupContext): Promise<ClientConfigState>;
  abstract install(context: SetupContext): Promise<ClientSetupResult>;
  abstract verify(context: SetupContext): Promise<ClientVerification>;
  abstract uninstall(context: SetupContext): Promise<ClientSetupResult>;
  abstract renderManualInstructions(context: SetupContext): ManualInstructions;

  protected result(detection: ClientDetection, action: ClientAction, overrides: Partial<ClientSetupResult> = {}): ClientSetupResult {
    return {
      id: this.id,
      name: this.name,
      detected: detection.detected,
      detectedBy: detection.detectedBy,
      method: "config-file",
      scope: "personal-repo",
      configPath: detection.configPath,
      action,
      verified: false,
      ...overrides,
    };
  }
}

class JsonAdapter extends BaseAdapter {
  constructor(
    readonly id: ClientId,
    readonly name: string,
    private readonly pathResolver: (context: SetupContext) => string,
    private readonly serverKey: "mcpServers" | "servers" | "mcp",
    readonly instructionFiles: InstructionTarget[],
  ) {
    super();
  }

  protected path(context: SetupContext): string {
    return this.pathResolver(context);
  }

  protected desired(context: SetupContext): Record<string, unknown> {
    return {
      command: "npx",
      args: ["-y", "@groveyard/mcp"],
      env: desiredEnvironment(context),
    };
  }

  protected readServers(config: Record<string, unknown>): Record<string, unknown> {
    const servers = config[this.serverKey];
    return isObject(servers) ? servers : {};
  }

  protected writeServers(config: Record<string, unknown>, servers: Record<string, unknown>): void {
    config[this.serverKey] = servers;
  }

  async detect(context: SetupContext): Promise<ClientDetection> {
    const configPath = this.path(context);
    const executable = await findExecutable(executableNames(this.id));
    const configExists = Boolean(configPath && existsSync(configPath));
    const configDirectory = Boolean(configPath && dirname(configPath) !== context.environment.home && existsSync(dirname(configPath)));
    return {
      detected: Boolean(executable || configExists || configDirectory),
      detectedBy: [executable ? `${executableName(executable)} executable` : "", configExists ? "config file" : "", configDirectory ? "config directory" : ""].filter(Boolean),
      configPath: configPath || undefined,
      executable,
    };
  }

  async inspect(context: SetupContext): Promise<ClientConfigState> {
    const path = this.path(context);
    const content = await readOptional(path);
    if (content === undefined) return { exists: false, valid: true, configured: false };

    try {
      const config = parseJsonObject(content);
      return {
        exists: true,
        valid: true,
        configured: deepEqual(this.readServers(config)[context.serverName], this.desired(context)),
        content,
      };
    } catch (error) {
      return { exists: true, valid: false, configured: false, content, error: `Malformed JSON configuration: ${errorMessage(error)}` };
    }
  }

  async install(context: SetupContext): Promise<ClientSetupResult> {
    const detection = await this.detect(context);
    const configPath = this.path(context);
    if (!configPath) return this.result(detection, "manual", { method: "manual", error: "No configuration path is available." });

    const state = await this.inspect(context);
    if (!state.valid) {
      return this.result(detection, "manual", { method: "manual", error: `Configuration is malformed: ${state.error}` });
    }
    if (state.configured) return this.result(detection, "unchanged", { verified: true });

    const config = state.content ? parseJsonObject(state.content) : {};
    this.writeServers(config, { ...this.readServers(config), [context.serverName]: this.desired(context) });
    const next = `${JSON.stringify(config, null, 2)}\n`;
    const write = await writeConfigSafely(configPath, next, state.exists);
    return this.result(detection, write.action, { backupPath: write.backupPath });
  }

  async verify(context: SetupContext): Promise<ClientVerification> {
    const state = await this.inspect(context);
    return state.valid && state.configured
      ? { verified: true }
      : { verified: false, detail: state.error ?? "The persisted server entry does not match Groveyard's expected configuration." };
  }

  async uninstall(context: SetupContext): Promise<ClientSetupResult> {
    const detection = await this.detect(context);
    const state = await this.inspect(context);
    if (!state.exists || !state.content || !state.valid) {
      return this.result(detection, state.valid ? "unchanged" : "manual", { method: state.valid ? "config-file" : "manual", error: state.error });
    }

    const config = parseJsonObject(state.content);
    const servers = this.readServers(config);
    if (!(context.serverName in servers)) return this.result(detection, "unchanged", { verified: true });
    const { [context.serverName]: _removed, ...remaining } = servers;
    this.writeServers(config, remaining);
    const write = await writeConfigSafely(this.path(context), `${JSON.stringify(config, null, 2)}\n`, true);
    return this.result(detection, "removed", { backupPath: write.backupPath, verified: true });
  }

  renderManualInstructions(context: SetupContext): ManualInstructions {
    return {
      id: this.id,
      format: "json",
      content: JSON.stringify({ [this.serverKey]: { [context.serverName]: this.desired(context) } }, null, 2),
      instructions: [`Add this entry under ${this.serverKey} without replacing unrelated servers.`],
    };
  }
}

class ClaudeCodeAdapter extends JsonAdapter {
  constructor() {
    super("claude-code", "Claude Code", claudeCodePath, "mcpServers", [{ relativePath: "CLAUDE.md" }]);
  }

  protected override readServers(config: Record<string, unknown>): Record<string, unknown> {
    const projects = isObject(config.projects) ? config.projects : {};
    const project = isObject(projects[this.currentRepoRoot]) ? projects[this.currentRepoRoot] : {};
    return isObject(project.mcpServers) ? project.mcpServers : {};
  }

  protected override writeServers(config: Record<string, unknown>, servers: Record<string, unknown>): void {
    const projects = isObject(config.projects) ? config.projects : {};
    const project = isObject(projects[this.currentRepoRoot]) ? projects[this.currentRepoRoot] : {};
    config.projects = { ...projects, [this.currentRepoRoot]: { ...project, mcpServers: servers } };
  }

  private currentRepoRoot = "";

  override async inspect(context: SetupContext): Promise<ClientConfigState> {
    this.currentRepoRoot = context.repoRoot;
    return super.inspect(context);
  }

  override async install(context: SetupContext): Promise<ClientSetupResult> {
    this.currentRepoRoot = context.repoRoot;
    return super.install(context);
  }

  override async uninstall(context: SetupContext): Promise<ClientSetupResult> {
    this.currentRepoRoot = context.repoRoot;
    return super.uninstall(context);
  }

  override renderManualInstructions(context: SetupContext): ManualInstructions {
    return {
      id: this.id,
      format: "json",
      content: JSON.stringify({ projects: { [context.repoRoot]: { mcpServers: { [context.serverName]: this.desired(context) } } } }, null, 2),
      instructions: ["Add this server under the current repository's projects entry in ~/.claude.json."],
    };
  }
}

class VscodeAdapter extends JsonAdapter {
  constructor() {
    super("vscode", "VS Code", vscodePath, "servers", [{ relativePath: ".github/copilot-instructions.md" }]);
  }
}

class OpenCodeAdapter extends JsonAdapter {
  constructor() {
    super("opencode", "OpenCode", openCodePath, "mcp", [{ relativePath: "AGENTS.md" }]);
  }

  protected override desired(context: SetupContext): Record<string, unknown> {
    return {
      type: "local",
      command: ["npx", "-y", "@groveyard/mcp"],
      enabled: true,
      environment: desiredEnvironment(context),
    };
  }
}

class GenericAdapter extends JsonAdapter {
  constructor() {
    super("generic", "Generic MCP client", (context) => context.genericConfigPath ?? "", "mcpServers", [{ relativePath: "AGENTS.md" }]);
  }

  override async detect(context: SetupContext): Promise<ClientDetection> {
    return {
      detected: Boolean(context.genericConfigPath),
      detectedBy: context.genericConfigPath ? ["--config"] : [],
      configPath: context.genericConfigPath,
    };
  }

  protected override readServers(config: Record<string, unknown>): Record<string, unknown> {
    const key = isObject(config.servers) ? "servers" : "mcpServers";
    return isObject(config[key]) ? config[key] : {};
  }

  protected override writeServers(config: Record<string, unknown>, servers: Record<string, unknown>): void {
    const key = isObject(config.servers) ? "servers" : "mcpServers";
    config[key] = servers;
  }
}

class CodexAdapter extends BaseAdapter {
  readonly id = "codex";
  readonly name = "Codex";
  readonly instructionFiles = [{ relativePath: "AGENTS.md" }];

  private path(context: SetupContext): string {
    return join(context.environment.home, ".codex", "config.toml");
  }

  async detect(context: SetupContext): Promise<ClientDetection> {
    const configPath = this.path(context);
    const executable = await findExecutable(["codex"]);
    const configExists = existsSync(configPath);
    const configDirectory = existsSync(dirname(configPath));
    return {
      detected: Boolean(executable || configExists || configDirectory),
      detectedBy: [executable ? "codex executable" : "", configExists ? "config file" : "", configDirectory ? "config directory" : ""].filter(Boolean),
      configPath,
      executable,
    };
  }

  async inspect(context: SetupContext): Promise<ClientConfigState> {
    const content = await readOptional(this.path(context));
    if (content === undefined) return { exists: false, valid: true, configured: false };
    const validation = validateTomlForManagedEdit(content, context.serverName);
    return {
      exists: true,
      valid: validation.valid,
      configured: validation.valid && codexHasExpectedServer(content, context),
      content,
      error: validation.error,
    };
  }

  async install(context: SetupContext): Promise<ClientSetupResult> {
    const detection = await this.detect(context);
    const state = await this.inspect(context);
    if (!state.valid) return this.result(detection, "manual", { method: "manual", error: state.error });
    if (state.configured) return this.result(detection, "unchanged", { verified: true });

    const next = upsertCodexServer(state.content ?? "", context);
    const write = await writeConfigSafely(this.path(context), next, state.exists);
    return this.result(detection, write.action, { backupPath: write.backupPath });
  }

  async verify(context: SetupContext): Promise<ClientVerification> {
    const state = await this.inspect(context);
    return state.valid && state.configured
      ? { verified: true }
      : { verified: false, detail: state.error ?? "The Codex MCP entry does not match Groveyard's expected configuration." };
  }

  async uninstall(context: SetupContext): Promise<ClientSetupResult> {
    const detection = await this.detect(context);
    const state = await this.inspect(context);
    if (!state.valid || !state.content) return this.result(detection, state.valid ? "unchanged" : "manual", { method: state.valid ? "config-file" : "manual", error: state.error });
    const next = removeCodexServer(state.content, context.serverName);
    if (next === state.content) return this.result(detection, "unchanged", { verified: true });
    const write = await writeConfigSafely(this.path(context), next, true);
    return this.result(detection, "removed", { backupPath: write.backupPath, verified: true });
  }

  renderManualInstructions(context: SetupContext): ManualInstructions {
    return {
      id: this.id,
      format: "toml",
      content: codexServerBlock(context),
      instructions: ["Add this block to ~/.codex/config.toml without replacing unrelated tables."],
    };
  }
}

function desiredEnvironment(context: SetupContext): Record<string, string> {
  return {
    GROVEYARD_REPO: context.repoRoot,
    GROVEYARD_AGENT_INSTRUCTIONS: context.agentInstructionsPath,
    GROVEYARD_MANAGED_VERSION: managedVersion,
  };
}

function codexServerBlock(context: SetupContext): string {
  const env = desiredEnvironment(context);
  return `[mcp_servers.${context.serverName}]
command = "npx"
args = ["-y", "@groveyard/mcp"]

[mcp_servers.${context.serverName}.env]
GROVEYARD_REPO = ${JSON.stringify(env.GROVEYARD_REPO)}
GROVEYARD_AGENT_INSTRUCTIONS = ${JSON.stringify(env.GROVEYARD_AGENT_INSTRUCTIONS)}
GROVEYARD_MANAGED_VERSION = ${JSON.stringify(env.GROVEYARD_MANAGED_VERSION)}`;
}

function upsertCodexServer(existing: string, context: SetupContext): string {
  const without = removeCodexServer(existing, context.serverName).trimEnd();
  return `${without ? `${without}\n\n` : ""}${codexServerBlock(context)}\n`;
}

function removeCodexServer(existing: string, serverName: string): string {
  const escaped = escapeRegExp(serverName);
  const lines = existing.split(/(?<=\n)/);
  const output: string[] = [];
  let removing = false;

  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?(?:\r?\n)?$/)?.[1];
    if (header) {
      if (header === `mcp_servers.${serverName}` || header === `mcp_servers.${serverName}.env`) {
        removing = true;
        continue;
      }
      if (removing && !new RegExp(`^mcp_servers\\.${escaped}(?:\\.|$)`).test(header)) removing = false;
    }
    if (!removing) output.push(line);
  }

  return output.join("").replace(/\n{3,}/g, "\n\n");
}

function codexHasExpectedServer(content: string, context: SetupContext): boolean {
  try {
    const config = parseToml(content) as Record<string, unknown>;
    const servers = isObject(config.mcp_servers) ? config.mcp_servers : {};
    const server = isObject(servers[context.serverName]) ? servers[context.serverName] : {};
    const env = isObject(server.env) ? server.env : {};
    return server.command === "npx" &&
      deepEqual(server.args, ["-y", "@groveyard/mcp"]) &&
      env.GROVEYARD_REPO === context.repoRoot &&
      env.GROVEYARD_AGENT_INSTRUCTIONS === context.agentInstructionsPath &&
      env.GROVEYARD_MANAGED_VERSION === managedVersion;
  } catch {
    return false;
  }
}

function validateTomlForManagedEdit(content: string, serverName: string): { valid: boolean; error?: string } {
  try {
    parseToml(content);
    return { valid: true };
  } catch (error) {
    return { valid: false, error: `Malformed TOML configuration: ${errorMessage(error)} Groveyard did not modify this file.` };
  }
}

async function writeManagedInstructions(path: string): Promise<InstructionResult["action"]> {
  const existing = await readOptional(path);
  if (existing === undefined) {
    await mkdir(dirname(path), { recursive: true });
    await atomicWrite(path, `${managedInstructionBlock}\n`);
    return "created";
  }

  validateManagedMarkers(existing, path);
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  const block = managedInstructionBlock.replace(/\n/g, newline);
  const next = existing.includes(managedStart)
    ? existing.replace(new RegExp(`${escapeRegExp(managedStart)}[\\s\\S]*?${escapeRegExp(managedEnd)}`), block)
    : `${existing}${existing.endsWith(newline) ? "" : newline}${existing.trim() ? newline : ""}${block}${newline}`;

  if (next === existing) return "unchanged";
  await atomicWrite(path, next);
  return "updated";
}

function validateManagedMarkers(content: string, path: string): void {
  const starts = content.split(managedStart).length - 1;
  const ends = content.split(managedEnd).length - 1;
  if ((starts === 0) !== (ends === 0) || starts > 1 || ends > 1 || (starts === 1 && content.indexOf(managedStart) > content.indexOf(managedEnd))) {
    throw new Error(`Conflicting Groveyard instruction markers in ${path}. Repair the markers before running setup again.`);
  }
}

async function writeConfigSafely(path: string, content: string, existed: boolean): Promise<{ action: "created" | "updated"; backupPath?: string }> {
  await mkdir(dirname(path), { recursive: true });
  let backupPath: string | undefined;
  if (existed) {
    backupPath = `${path}.groveyard-backup`;
    await copyFile(path, backupPath);
  }
  await atomicWrite(path, content);
  return { action: existed ? "updated" : "created", backupPath };
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, path);
}

async function readOptional(path: string): Promise<string | undefined> {
  if (!path) return undefined;
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function parseJsonObject(content: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(content);
  if (!isObject(parsed)) throw new Error("Expected a JSON object at the configuration root.");
  return parsed;
}

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function primaryTieBreak(id: ClientId): number {
  return ({ codex: 8, vscode: 7, "claude-code": 6, cursor: 5, gemini: 4, opencode: 3, "claude-desktop": 2, generic: 1 })[id];
}

async function findExecutable(names: string[]): Promise<string | undefined> {
  if (process.env.GROVEYARD_TEST_DISABLE_EXECUTABLE_DETECTION === "1") return undefined;
  for (const name of names) {
    for (const directory of (process.env.PATH ?? "").split(delimiter)) {
      if (!directory) continue;
      const candidate = join(directory, name);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return undefined;
}

function executableNames(id: ClientId): string[] {
  switch (id) {
    case "vscode": return ["code", "code-insiders"];
    case "claude-code": return ["claude"];
    case "claude-desktop": return [];
    default: return [id];
  }
}

function executableName(path: string): string {
  return basename(path);
}

function vscodePath(context: SetupContext): string {
  if (platform() === "darwin") return join(context.environment.home, "Library", "Application Support", "Code", "User", "mcp.json");
  if (platform() === "win32") return join(context.environment.home, "AppData", "Roaming", "Code", "User", "mcp.json");
  return join(context.environment.home, ".config", "Code", "User", "mcp.json");
}

function claudeDesktopPath(context: SetupContext): string {
  if (platform() === "darwin") return join(context.environment.home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform() === "win32") return join(context.environment.home, "AppData", "Roaming", "Claude", "claude_desktop_config.json");
  return join(context.environment.home, ".config", "Claude", "claude_desktop_config.json");
}

function claudeCodePath(context: SetupContext): string { return join(context.environment.home, ".claude.json"); }
function cursorPath(context: SetupContext): string { return join(context.environment.home, ".cursor", "mcp.json"); }
function geminiPath(context: SetupContext): string { return join(context.environment.home, ".gemini", "settings.json"); }
function openCodePath(context: SetupContext): string { return join(context.environment.home, ".config", "opencode", "opencode.json"); }

function readProcVersion(): string {
  try {
    return readFileSync("/proc/version", "utf8");
  } catch {
    return "";
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error; }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
