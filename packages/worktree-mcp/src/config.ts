import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

const configFileName = ".worktree-mcp.yml";

const configSchema = z.object({
  worktreesRoot: z.string().min(1).default(".agent-worktrees"),
  branchPrefix: z.string().min(1).default("agent/"),
  allowDirtyBase: z.boolean().default(false),
  commands: z.record(z.string().min(1)).default({}),
});

export type WorktreeMcpConfig = z.infer<typeof configSchema>;

export async function loadConfig(repoRoot: string): Promise<WorktreeMcpConfig> {
  let raw: string;

  try {
    raw = await readFile(join(repoRoot, configFileName), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return configSchema.parse({});
    }

    throw error;
  }

  return configSchema.parse(parseYaml(raw) ?? {});
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
