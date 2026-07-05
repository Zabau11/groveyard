import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { taskPlanSchema } from "../schemas/task-plan.js";

const compositionSummarySchema = z.object({
  runId: z.string(),
  status: z.enum(["composed", "composed_with_skips", "failed"]),
  branch: z.string(),
  workspacePath: z.string(),
});

type VerificationCommandResult = {
  command: string;
  status: "passed" | "failed";
  exitCode: number;
  durationMs: number;
  logPath: string;
};

type VerificationSummary = {
  runId: string;
  status: "passed" | "failed" | "skipped";
  workspacePath: string;
  commands: VerificationCommandResult[];
};

export async function verifyRun(runId: string, cwd: string): Promise<VerificationSummary> {
  const runRoot = join(cwd, ".paraflow", "runs", runId);
  const taskPlanPath = join(runRoot, "task-plan.yml");
  const compositionPath = join(runRoot, "composition.json");

  if (!(await pathExists(taskPlanPath))) {
    throw new Error(`Task plan not found: .paraflow/runs/${runId}/task-plan.yml`);
  }

  if (!(await pathExists(compositionPath))) {
    throw new Error(`Composition summary not found: .paraflow/runs/${runId}/composition.json. Run paraflow compose first.`);
  }

  const plan = taskPlanSchema.parse(parseYaml(await readFile(taskPlanPath, "utf8")));
  const composition = compositionSummarySchema.parse(JSON.parse(await readFile(compositionPath, "utf8")));

  if (!(await pathExists(composition.workspacePath))) {
    throw new Error(`Integration workspace not found: ${composition.workspacePath}`);
  }

  const verifyRoot = join(runRoot, "verify");
  await mkdir(verifyRoot, { recursive: true });

  const commands: VerificationCommandResult[] = [];
  for (const [index, command] of plan.verify.entries()) {
    commands.push(await runVerificationCommand(command, index, composition.workspacePath, verifyRoot));
  }

  const status = commands.length === 0 ? "skipped" : commands.some((command) => command.status === "failed") ? "failed" : "passed";
  const summary: VerificationSummary = {
    runId,
    status,
    workspacePath: composition.workspacePath,
    commands,
  };

  await writeFile(join(runRoot, "verification.json"), `${JSON.stringify(summary, null, 2)}\n`);

  return summary;
}

async function runVerificationCommand(command: string, index: number, workspacePath: string, verifyRoot: string): Promise<VerificationCommandResult> {
  const started = Date.now();
  const result = await execa(command, {
    cwd: workspacePath,
    shell: true,
    reject: false,
    all: true,
  });
  const durationMs = Date.now() - started;
  const exitCode = result.exitCode ?? 1;
  const status = exitCode === 0 ? "passed" : "failed";
  const logPath = join(verifyRoot, `${String(index + 1).padStart(2, "0")}.log`);

  await writeFile(
    logPath,
    [
      `Command: ${command}`,
      `Status: ${status}`,
      `Exit code: ${exitCode}`,
      `Duration: ${durationMs}ms`,
      "",
      result.all ?? "",
    ].join("\n"),
  );

  return {
    command,
    status,
    exitCode,
    durationMs,
    logPath,
  };
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
