import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { AgentPlan } from "../schemas/task-plan.js";

const adapterConfigSchema = z.object({
  type: z.string().default("shell"),
  commandTemplate: z.string().optional(),
  description: z.string().optional(),
  detect: z.array(z.string()).optional(),
});

const agentxConfigSchema = z.object({
  version: z.literal(1),
  adapters: z.record(adapterConfigSchema).default({}),
});

export type AdapterConfig = z.infer<typeof adapterConfigSchema>;

export type AdapterListItem = {
  name: string;
  type: string;
  commandTemplate?: string;
  description?: string;
  detect?: string[];
};

type ResolveCommandInput = {
  agentName: string;
  agent: AgentPlan;
  taskFile: string;
};

export async function listAdapters(cwd: string): Promise<AdapterListItem[]> {
  const config = await loadAgentxConfig(cwd);

  return Object.entries(config.adapters)
    .map(([name, adapter]) => ({
      name,
      type: adapter.type,
      commandTemplate: adapter.commandTemplate,
      description: adapter.description,
      detect: adapter.detect,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function resolveAgentCommand(cwd: string, input: ResolveCommandInput): Promise<string> {
  if (input.agent.command) {
    return input.agent.command;
  }

  const config = await loadAgentxConfig(cwd);
  const adapter = config.adapters[input.agent.adapter];
  if (!adapter) {
    throw new Error(`Unknown adapter "${input.agent.adapter}" for agent "${input.agentName}".`);
  }

  const resolvedAdapter = adapter.type === "auto" ? await detectAdapter(config.adapters, adapter, input.agentName) : adapter;

  if (!resolvedAdapter.commandTemplate) {
    throw new Error(`Adapter "${input.agent.adapter}" does not define commandTemplate, and agent "${input.agentName}" has no command.`);
  }

  return renderTemplate(resolvedAdapter.commandTemplate, {
    agent: input.agentName,
    task: input.agent.task,
    taskFile: input.taskFile,
  });
}

async function detectAdapter(adapters: Record<string, AdapterConfig>, adapter: AdapterConfig, agentName: string): Promise<AdapterConfig> {
  const candidates = adapter.detect ?? ["codex", "claude", "cursor", "noop"];

  for (const candidateName of candidates) {
    const candidate = adapters[candidateName];
    if (!candidate) {
      continue;
    }

    if (candidateName === "noop") {
      return candidate;
    }

    if (await commandExists(commandNameFromTemplate(candidate.commandTemplate))) {
      return candidate;
    }
  }

  throw new Error(`Could not auto-detect an installed agent command for "${agentName}". Configure .agentx/config.yml or use --adapter noop.`);
}

function commandNameFromTemplate(template: string | undefined): string | undefined {
  return template?.trim().split(/\s+/)[0];
}

async function commandExists(command: string | undefined): Promise<boolean> {
  if (!command) {
    return false;
  }

  const result = await execa("command", ["-v", command], {
    shell: true,
    reject: false,
  });

  return result.exitCode === 0;
}

async function loadAgentxConfig(cwd: string): Promise<z.infer<typeof agentxConfigSchema>> {
  const configPath = join(cwd, ".agentx", "config.yml");
  if (!(await pathExists(configPath))) {
    return {
      version: 1,
      adapters: {},
    };
  }

  return agentxConfigSchema.parse(parseYaml(await readFile(configPath, "utf8")));
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replaceAll(/{{\s*(agent|task|taskFile)\s*}}/g, (_match, key: string) => shellQuote(values[key] ?? ""));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
