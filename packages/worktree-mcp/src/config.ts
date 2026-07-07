import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

const configFileName = ".groveyard.yml";

const safeRelativePathSchema = z
  .string()
  .min(1)
  .transform((value) => normalize(value))
  .refine((value) => !isAbsolute(value), "Path must be relative.")
  .refine((value) => value !== ".." && !value.startsWith(`..${"/"}`) && !value.startsWith(`..${"\\"}`), "Path must not escape the repo.");

const branchPrefixSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/") && !value.startsWith("-"), "Branch prefix must not start with / or -.")
  .refine((value) => !value.includes("..") && !value.includes(" ") && !value.includes("\\"), "Branch prefix contains unsafe characters.");

const configSchema = z.object({
  worktreesRoot: safeRelativePathSchema.default(".agent-worktrees"),
  branchPrefix: branchPrefixSchema.default("agent/"),
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
