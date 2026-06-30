import { readFile } from "node:fs/promises";
import { ZodError } from "zod";
import { agentManifestSchema, type AgentManifest } from "../schemas/agent-manifest.js";

export type ManifestValidation = {
  valid: boolean;
  errors: string[];
  manifest?: AgentManifest;
};

type ManifestIdField = "exports" | "routes" | "navigation" | "permissions";

const idFields: ManifestIdField[] = ["exports", "routes", "navigation", "permissions"];

export async function validateManifestFile(manifestPath: string, agentName: string): Promise<ManifestValidation> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    return {
      valid: false,
      errors: [`Manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  try {
    const manifest = agentManifestSchema.parse(parsed);
    const errors: string[] = [];

    if (manifest.agent !== agentName) {
      errors.push(`Manifest agent "${manifest.agent}" does not match plan agent "${agentName}".`);
    }

    return {
      valid: errors.length === 0,
      errors,
      manifest,
    };
  } catch (error) {
    if (error instanceof ZodError) {
      return {
        valid: false,
        errors: error.issues.map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`),
      };
    }

    throw error;
  }
}

export function findDuplicateManifestIds(manifests: Map<string, AgentManifest>): Map<string, string[]> {
  const ownersByKey = new Map<string, string[]>();

  for (const [agentName, manifest] of manifests.entries()) {
    for (const field of idFields) {
      for (const item of manifest[field]) {
        const key = `${field}:${item.id}`;
        ownersByKey.set(key, [...(ownersByKey.get(key) ?? []), agentName]);
      }
    }
  }

  const duplicates = new Map<string, string[]>();
  for (const [key, owners] of ownersByKey.entries()) {
    if (owners.length > 1) {
      duplicates.set(key, owners);
    }
  }

  return duplicates;
}
