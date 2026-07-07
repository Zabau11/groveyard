import { execFile } from "node:child_process";

export type CommandRunResult = {
  profile: string;
  command: string;
  args: string[];
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

export class UnknownCommandProfileError extends Error {
  constructor(profile: string) {
    super(`Unknown command profile: ${profile}`);
    this.name = "UnknownCommandProfileError";
  }
}

export class UnsafeCommandError extends Error {
  constructor(command: string) {
    super(`Command profile contains unsupported shell syntax: ${command}`);
    this.name = "UnsafeCommandError";
  }
}

export async function runCommandProfile(cwd: string, profile: string, configuredCommand: string): Promise<CommandRunResult> {
  const [command, ...args] = parseCommand(configuredCommand);

  if (!command) {
    throw new UnsafeCommandError(configuredCommand);
  }

  const result = await execFileResult(command, args, cwd);

  return {
    profile,
    command,
    args,
    cwd,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function parseCommand(configuredCommand: string): string[] {
  if (/[\n\r;&|<>`$(){}]/.test(configuredCommand)) {
    throw new UnsafeCommandError(configuredCommand);
  }

  const parts = configuredCommand.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];

  return parts.map((part) => {
    if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) {
      return part.slice(1, -1);
    }

    if (part.includes('"') || part.includes("'")) {
      throw new UnsafeCommandError(configuredCommand);
    }

    return part;
  });
}

function execFileResult(command: string, args: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd,
        maxBuffer: 1024 * 1024 * 20,
        timeout: 120_000,
      },
      (error, stdout, stderr) => {
        if (error && hasExitCode(error)) {
          resolve({
            exitCode: typeof error.code === "number" ? error.code : 1,
            stdout,
            stderr,
          });
          return;
        }

        if (error) {
          resolve({
            exitCode: 1,
            stdout,
            stderr: stderr || error.message,
          });
          return;
        }

        resolve({
          exitCode: 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

function hasExitCode(error: Error): error is Error & { code?: number | string } {
  return "code" in error;
}
