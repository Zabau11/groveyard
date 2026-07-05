import type { TaskPlan } from "../schemas/task-plan.js";
import { validateChangedFiles } from "./ownership.js";

export type DiffFileChangeKind = "added" | "modified" | "deleted" | "renamed" | "copied";

export type DiffFileChange = {
  oldPath?: string;
  newPath?: string;
  kind: DiffFileChangeKind;
};

export type DiffValidation = {
  accepted: boolean;
  changedFiles: string[];
  fileChanges: DiffFileChange[];
  violations: string[];
};

type MutableDiffFileChange = {
  oldPath?: string;
  newPath?: string;
  kind?: DiffFileChangeKind;
};

export function validateDiff(plan: TaskPlan, agentName: string, diffText: string): DiffValidation {
  const fileChanges = parseDiffFileChanges(diffText);
  const changedFiles = getTouchedFiles(fileChanges);
  const unsafePaths = changedFiles.filter((filePath) => !isSafeRepositoryPath(filePath));
  const ownership = validateChangedFiles(plan, agentName, changedFiles);
  const violations = [
    ...unsafePaths.map((filePath) => `${filePath} is not a safe repository-relative path.`),
    ...ownership.violations,
  ];

  return {
    accepted: violations.length === 0,
    changedFiles,
    fileChanges,
    violations,
  };
}

export function parseDiffFileChanges(diffText: string): DiffFileChange[] {
  const changes: DiffFileChange[] = [];
  let current: MutableDiffFileChange | undefined;

  const flush = () => {
    if (!current) {
      return;
    }

    const oldPath = normalizeDiffPath(current.oldPath);
    const newPath = normalizeDiffPath(current.newPath);

    if (oldPath || newPath) {
      changes.push({
        oldPath,
        newPath,
        kind: current.kind ?? inferChangeKind(oldPath, newPath),
      });
    }

    current = undefined;
  };

  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      flush();
      current = parseDiffGitLine(line);
      continue;
    }

    if (!current) {
      current = {};
    }

    if (line === "new file mode" || line.startsWith("new file mode ")) {
      current.kind = "added";
      continue;
    }

    if (line === "deleted file mode" || line.startsWith("deleted file mode ")) {
      current.kind = "deleted";
      continue;
    }

    if (line.startsWith("rename from ")) {
      current.oldPath = line.slice("rename from ".length);
      current.kind = "renamed";
      continue;
    }

    if (line.startsWith("rename to ")) {
      current.newPath = line.slice("rename to ".length);
      current.kind = "renamed";
      continue;
    }

    if (line.startsWith("copy from ")) {
      current.oldPath = line.slice("copy from ".length);
      current.kind = "copied";
      continue;
    }

    if (line.startsWith("copy to ")) {
      current.newPath = line.slice("copy to ".length);
      current.kind = "copied";
      continue;
    }

    if (line.startsWith("--- ")) {
      current.oldPath = parsePatchPath(line.slice("--- ".length));
      continue;
    }

    if (line.startsWith("+++ ")) {
      current.newPath = parsePatchPath(line.slice("+++ ".length));
    }
  }

  flush();

  return changes;
}

export function getTouchedFiles(fileChanges: DiffFileChange[]): string[] {
  const touched = new Set<string>();

  for (const change of fileChanges) {
    for (const filePath of [change.oldPath, change.newPath]) {
      const normalized = normalizeDiffPath(filePath);
      if (normalized) {
        touched.add(normalized);
      }
    }
  }

  return [...touched];
}

function parseDiffGitLine(line: string): MutableDiffFileChange {
  const paths = splitDiffGitPaths(line.slice("diff --git ".length));
  if (!paths) {
    return {};
  }

  return {
    oldPath: parsePatchPath(paths[0]),
    newPath: parsePatchPath(paths[1]),
  };
}

function parsePatchPath(value: string): string | undefined {
  const path = unquoteGitPath(value.split(/\t/)[0]?.trim() ?? "");

  if (!path || path === "/dev/null") {
    return undefined;
  }

  if (path.startsWith("a/") || path.startsWith("b/")) {
    return path.slice(2);
  }

  return path;
}

function splitDiffGitPaths(value: string): [string, string] | undefined {
  const first = readDiffGitPath(value);
  if (!first) {
    return undefined;
  }

  const second = readDiffGitPath(first.rest.trimStart());
  if (!second) {
    return undefined;
  }

  return [first.path, second.path];
}

function readDiffGitPath(value: string): { path: string; rest: string } | undefined {
  if (value.startsWith('"')) {
    for (let index = 1; index < value.length; index += 1) {
      if (value[index] === '"' && value[index - 1] !== "\\") {
        return {
          path: value.slice(0, index + 1),
          rest: value.slice(index + 1),
        };
      }
    }

    return undefined;
  }

  const separator = value.indexOf(" b/");
  if (separator === -1) {
    const path = value.trim();
    return path ? { path, rest: "" } : undefined;
  }

  return {
    path: value.slice(0, separator),
    rest: value.slice(separator + 1),
  };
}

function unquoteGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) {
    return value;
  }

  try {
    return JSON.parse(value) as string;
  } catch {
    return value.slice(1, -1);
  }
}

function normalizeDiffPath(filePath: string | undefined): string | undefined {
  if (!filePath || filePath === "/dev/null") {
    return undefined;
  }

  return filePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function inferChangeKind(oldPath: string | undefined, newPath: string | undefined): DiffFileChangeKind {
  if (!oldPath && newPath) {
    return "added";
  }

  if (oldPath && !newPath) {
    return "deleted";
  }

  if (oldPath && newPath && oldPath !== newPath) {
    return "renamed";
  }

  return "modified";
}

function isSafeRepositoryPath(filePath: string): boolean {
  return (
    filePath.length > 0 &&
    !filePath.startsWith("/") &&
    !filePath.startsWith("../") &&
    !filePath.includes("/../") &&
    filePath !== ".."
  );
}
