import { execFile } from "node:child_process";
import { readdir, readlink, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const gracefulShutdownMs = 1_500;

export type ProcessCleanupResult = {
  terminatedPids: number[];
};

export async function terminateProcessesInWorktree(worktreePath: string): Promise<ProcessCleanupResult> {
  const root = await normalizePath(worktreePath);
  const pids = await findProcessesInWorktree(root);
  const terminatedPids: number[] = [];

  for (const pid of pids) {
    if (pid === process.pid) {
      continue;
    }

    if (await terminateProcess(pid)) {
      terminatedPids.push(pid);
    }
  }

  return { terminatedPids };
}

async function findProcessesInWorktree(root: string): Promise<number[]> {
  if (process.platform === "win32") {
    return [];
  }

  if (await hasProcFilesystem()) {
    return findProcessesFromProc(root);
  }

  return findProcessesFromLsof(root);
}

async function findProcessesFromProc(root: string): Promise<number[]> {
  const entries = await readdir("/proc");
  const pids: number[] = [];

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }

    const pid = Number(entry);
    let cwd: string;

    try {
      cwd = await readlink(`/proc/${pid}/cwd`);
    } catch {
      continue;
    }

    if (isPathInside(root, stripDeletedSuffix(cwd))) {
      pids.push(pid);
    }
  }

  return pids;
}

async function findProcessesFromLsof(root: string): Promise<number[]> {
  let stdout: string;

  try {
    const result = await execFileAsync("lsof", ["-w", "-F", "p", "-a", "-d", "cwd", "+D", root], {
      maxBuffer: 1024 * 1024,
      timeout: 5_000,
    });
    stdout = result.stdout;
  } catch (error) {
    if (isExecError(error) && error.code === 1) {
      stdout = error.stdout ?? "";
    } else if (isExecError(error) && error.code === "ENOENT") {
      return [];
    } else {
      throw error;
    }
  }

  return Array.from(
    new Set(
      stdout
        .split("\n")
        .filter((line) => line.startsWith("p"))
        .map((line) => Number(line.slice(1)))
        .filter((pid) => Number.isInteger(pid) && pid > 0),
    ),
  );
}

async function terminateProcess(pid: number): Promise<boolean> {
  if (!processExists(pid)) {
    return false;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") {
      return false;
    }

    throw error;
  }

  if (await waitForExit(pid, gracefulShutdownMs)) {
    return true;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") {
      return true;
    }

    throw error;
  }

  if (!(await waitForExit(pid, gracefulShutdownMs))) {
    throw new Error(`Process ${pid} is still running after cleanup signals.`);
  }

  return true;
}

async function hasProcFilesystem(): Promise<boolean> {
  try {
    await readdir("/proc");
    return true;
  } catch {
    return false;
  }
}

async function normalizePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);

  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${sep}`);
}

function stripDeletedSuffix(path: string): string {
  return path.endsWith(" (deleted)") ? path.slice(0, -" (deleted)".length) : path;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") {
      return false;
    }

    throw error;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!processExists(pid)) {
      return true;
    }

    await sleep(50);
  }

  return !processExists(pid);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isExecError(error: unknown): error is Error & { code?: number | string; stdout?: string } {
  return error instanceof Error && "code" in error;
}
