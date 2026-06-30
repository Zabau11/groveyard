import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { AgentPlan } from "../schemas/task-plan.js";

const adapterConfigSchema = z.object({
  type: z.string().default("shell"),
  commandTemplate: z.string().optional(),
  description: z.string().optional(),
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

  if (!adapter.commandTemplate) {
    throw new Error(`Adapter "${input.agent.adapter}" does not define commandTemplate, and agent "${input.agentName}" has no command.`);
  }

  return renderTemplate(adapter.commandTemplate, {
    agent: input.agentName,
    task: input.agent.task,
    taskFile: input.taskFile,
  });
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
