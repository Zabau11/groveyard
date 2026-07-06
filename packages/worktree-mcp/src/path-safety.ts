import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePathError";
  }
}

export async function resolveExistingSessionPath(worktreePath: string, userPath: string): Promise<string> {
  const root = await realpath(worktreePath);
  const target = resolveLexicalPath(root, userPath);
  assertInside(root, target, userPath);

  const actualTarget = await realpath(target);

  assertInside(root, actualTarget, userPath);
  return actualTarget;
}

export async function resolveWritableSessionPath(worktreePath: string, userPath: string): Promise<string> {
  const root = await realpath(worktreePath);
  const target = resolveLexicalPath(root, userPath);
  assertInside(root, target, userPath);

  try {
    const stats = await lstat(target);

    if (stats.isSymbolicLink()) {
      const actualTarget = await realpath(target);
      assertInside(root, actualTarget, userPath);
      return actualTarget;
    }

    return target;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const actualParent = await realpath(parent);
  assertInside(root, actualParent, userPath);

  return target;
}

export function toSessionRelativePath(worktreePath: string, absolutePath: string): string {
  const rel = relative(worktreePath, absolutePath);
  return rel.split(sep).join("/");
}

function resolveLexicalPath(root: string, userPath: string): string {
  if (userPath.trim().length === 0) {
    throw new UnsafePathError("Path must not be empty.");
  }

  if (isAbsolute(userPath)) {
    throw new UnsafePathError(`Absolute paths are not allowed: ${userPath}`);
  }

  return resolve(root, userPath);
}

function assertInside(root: string, target: string, userPath: string): void {
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new UnsafePathError(`Path escapes the session worktree: ${userPath}`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
