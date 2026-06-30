import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

type InitResult = {
  created: string[];
  skipped: string[];
};

const agentxDir = ".agentx";

const files = {
  "config.yml": `version: 1

# Commands run by agentx verify. Keep this empty until the project-specific
# checks are known.
verify: []

# Paths protected for every normal agent run.
protected:
  - ".agentx/**"
  - "contracts/**"
  - "src/generated/**"
  - "package.json"
  - "package-lock.json"
  - "pnpm-lock.yaml"
  - "yarn.lock"

adapters:
  auto:
    type: "auto"
    detect:
      - "codex"
      - "claude"
      - "cursor"
    description: "Automatically picks the first available real agent command."

  generic:
    type: "shell"
    description: "Use the command field from each agent in the task plan."

  noop:
    type: "shell"
    commandTemplate: "mkdir -p agent-output && printf '{\\"version\\":1,\\"agent\\":\\"%s\\",\\"summary\\":\\"No-op adapter output.\\"}\\\\n' {{agent}} > agent-output/manifest.json"
    description: "Local no-op adapter for testing plans without invoking a real coding agent."

  codex:
    type: "shell"
    commandTemplate: "codex exec --full-auto {{taskFile}}"
    description: "Runs Codex CLI against the generated task file. Edit this template if your local Codex CLI uses different flags."

  claude:
    type: "shell"
    commandTemplate: 'claude -p "$(cat {{taskFile}})"'
    description: "Runs Claude Code with the generated task file as the prompt."

  cursor:
    type: "shell"
    commandTemplate: 'cursor-agent -p "$(cat {{taskFile}})"'
    description: "Example Cursor agent command template; adjust to your local Cursor agent CLI."
`,
  "ownership.yml": `version: 1

domains: {}

protected:
  - ".agentx/**"
  - "contracts/**"
  - "src/generated/**"
  - "package.json"
  - "package-lock.json"
  - "pnpm-lock.yaml"
  - "yarn.lock"
`,
  "schemas/manifest.schema.json": `${JSON.stringify(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "AgentX Agent Manifest",
      type: "object",
      required: ["version", "agent", "summary"],
      additionalProperties: false,
      properties: {
        version: {
          const: 1,
        },
        agent: {
          type: "string",
          minLength: 1,
        },
        feature: {
          type: "string",
        },
        summary: {
          type: "string",
          minLength: 1,
        },
        exports: {
          type: "array",
          default: [],
          items: {
            type: "object",
            required: ["id", "symbol", "from"],
            additionalProperties: false,
            properties: {
              id: { type: "string", minLength: 1 },
              symbol: { type: "string", minLength: 1 },
              from: { type: "string", minLength: 1 },
            },
          },
        },
        routes: {
          type: "array",
          default: [],
          items: {
            type: "object",
            required: ["id", "path", "component"],
            additionalProperties: false,
            properties: {
              id: { type: "string", minLength: 1 },
              path: { type: "string", minLength: 1 },
              component: { type: "string", minLength: 1 },
              priority: { type: "number" },
            },
          },
        },
        navigation: {
          type: "array",
          default: [],
          items: {
            type: "object",
            required: ["id", "label", "path"],
            additionalProperties: false,
            properties: {
              id: { type: "string", minLength: 1 },
              label: { type: "string", minLength: 1 },
              path: { type: "string", minLength: 1 },
              permission: { type: "string" },
            },
          },
        },
        permissions: {
          type: "array",
          default: [],
          items: {
            type: "object",
            required: ["id", "name"],
            additionalProperties: false,
            properties: {
              id: { type: "string", minLength: 1 },
              name: { type: "string", minLength: 1 },
            },
          },
        },
        contractChangeRequests: {
          type: "array",
          default: [],
          items: {
            type: "object",
            required: ["contract", "requestedChange", "reason"],
            additionalProperties: false,
            properties: {
              contract: { type: "string", minLength: 1 },
              requestedChange: { type: "string", minLength: 1 },
              reason: { type: "string", minLength: 1 },
              impact: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
        },
        dependencyRequests: {
          type: "array",
          default: [],
          items: {
            type: "object",
            required: ["name", "reason"],
            additionalProperties: false,
            properties: {
              name: { type: "string", minLength: 1 },
              version: { type: "string" },
              type: {
                enum: ["runtime", "development", "peer", "optional"],
              },
              reason: { type: "string", minLength: 1 },
            },
          },
        },
      },
    },
    null,
    2,
  )}
`,
};

export async function initAgentx(cwd: string): Promise<InitResult> {
  const created: string[] = [];
  const skipped: string[] = [];

  for (const directory of [agentxDir, join(agentxDir, "runs"), join(agentxDir, "reports"), join(agentxDir, "schemas"), join(agentxDir, "worktrees")]) {
    const fullPath = join(cwd, directory);
    if (await pathExists(fullPath)) {
      skipped.push(`${directory}/`);
    } else {
      await mkdir(fullPath, { recursive: true });
      created.push(`${directory}/`);
    }
  }

  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = join(cwd, agentxDir, relativePath);
    try {
      await writeFile(fullPath, contents, { flag: "wx" });
      created.push(join(agentxDir, relativePath));
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        skipped.push(join(agentxDir, relativePath));
        continue;
      }

      throw error;
    }
  }

  return { created, skipped };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }

    throw error;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
