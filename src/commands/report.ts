import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const agentRunSummarySchema = z.object({
  agent: z.string(),
  status: z.enum(["accepted", "rejected", "failed"]),
  exitCode: z.number(),
  changedFiles: z.array(z.string()),
  violations: z.array(z.string()),
  manifestValidation: z.object({
    valid: z.boolean(),
    errors: z.array(z.string()),
  }),
  logPath: z.string(),
  patchPath: z.string(),
  manifestPath: z.string().optional(),
});

const runSummarySchema = z.object({
  runId: z.string(),
  baseBranch: z.string(),
  status: z.enum(["completed", "completed_with_rejections", "failed"]),
  planPath: z.string(),
  runPath: z.string(),
  agents: z.array(agentRunSummarySchema),
});

const compositionSummarySchema = z.object({
  runId: z.string(),
  status: z.enum(["composed", "composed_with_skips", "failed"]),
  branch: z.string(),
  workspacePath: z.string(),
  applied: z.array(
    z.object({
      agent: z.string(),
      patchPath: z.string(),
      changedFiles: z.array(z.string()),
    }),
  ),
  generatedFiles: z.array(
    z.object({
      type: z.string(),
      path: z.string(),
      count: z.number(),
    }),
  ).default([]),
  skipped: z.array(
    z.object({
      agent: z.string(),
      status: z.enum(["accepted", "rejected", "failed"]),
      reason: z.string(),
    }),
  ),
});

const verificationSummarySchema = z.object({
  runId: z.string(),
  status: z.enum(["passed", "failed", "skipped"]),
  workspacePath: z.string(),
  commands: z.array(
    z.object({
      command: z.string(),
      status: z.enum(["passed", "failed"]),
      exitCode: z.number(),
      durationMs: z.number(),
      logPath: z.string(),
    }),
  ),
});

type RunSummary = z.output<typeof runSummarySchema>;
type CompositionSummary = z.infer<typeof compositionSummarySchema>;
type VerificationSummary = z.output<typeof verificationSummarySchema>;

type ReportResult = {
  runId: string;
  reportPath: string;
  mirrorPath: string;
  markdown: string;
};

export async function generateReport(runId: string, cwd: string): Promise<ReportResult> {
  const runRoot = join(cwd, ".paraflow", "runs", runId);
  const runSummaryPath = join(runRoot, "summary.json");

  if (!(await pathExists(runSummaryPath))) {
    throw new Error(`Run summary not found: .paraflow/runs/${runId}/summary.json`);
  }

  const run = runSummarySchema.parse(JSON.parse(await readFile(runSummaryPath, "utf8")));
  const composition = await readOptionalJson(join(runRoot, "composition.json"), compositionSummarySchema);
  const verification = await readOptionalJson(join(runRoot, "verification.json"), verificationSummarySchema);
  const markdown = renderReport(run, composition, verification);
  const reportPath = join(runRoot, "report.md");
  const mirrorPath = join(cwd, ".paraflow", "reports", `${runId}.md`);

  await mkdir(join(cwd, ".paraflow", "reports"), { recursive: true });
  await writeFile(reportPath, markdown);
  await writeFile(mirrorPath, markdown);

  return {
    runId,
    reportPath,
    mirrorPath,
    markdown,
  };
}

function renderReport(run: RunSummary, composition: CompositionSummary | undefined, verification: VerificationSummary | undefined): string {
  const acceptedAgents = run.agents.filter((agent) => agent.status === "accepted");
  const rejectedAgents = run.agents.filter((agent) => agent.status === "rejected");
  const failedAgents = run.agents.filter((agent) => agent.status === "failed");
  const preventedIssues = run.agents.flatMap((agent) => agent.violations.map((violation) => ({ agent: agent.agent, violation })));

  const lines: string[] = [
    `# Paraflow Run Report`,
    "",
    `Run: \`${run.runId}\``,
    "",
    `Base branch: \`${run.baseBranch}\``,
    "",
    `Run status: \`${run.status}\``,
    "",
    "## Agent Results",
    "",
    "| Agent | Status | Changed Files | Manifest |",
    "|---|---:|---:|---|",
    ...run.agents.map((agent) => `| ${escapeTable(agent.agent)} | ${agent.status} | ${agent.changedFiles.length} | ${agent.manifestValidation.valid ? "valid" : "invalid"} |`),
    "",
    `Accepted agents: ${acceptedAgents.length}`,
    "",
    `Rejected agents: ${rejectedAgents.length}`,
    "",
    `Failed agents: ${failedAgents.length}`,
    "",
  ];

  if (preventedIssues.length > 0) {
    lines.push("## Prevented Issues", "");
    for (const issue of preventedIssues) {
      lines.push(`- \`${issue.agent}\`: ${issue.violation}`);
    }
    lines.push("");
  }

  lines.push("## Changed Files", "");
  for (const agent of run.agents) {
    lines.push(`### ${agent.agent}`, "");
    if (agent.changedFiles.length === 0) {
      lines.push("- None");
    } else {
      for (const filePath of agent.changedFiles) {
        lines.push(`- \`${filePath}\``);
      }
    }
    lines.push("");
  }

  lines.push("## Composition", "");
  if (composition) {
    const generatedFiles = composition.generatedFiles ?? [];
    lines.push(`Status: \`${composition.status}\``, "");
    lines.push(`Branch: \`${composition.branch}\``, "");
    lines.push(`Workspace: \`${composition.workspacePath}\``, "");
    lines.push(`Applied patches: ${composition.applied.length}`, "");
    for (const applied of composition.applied) {
      lines.push(`- \`${applied.agent}\`: ${applied.changedFiles.length} changed files`);
    }
    if (composition.skipped.length > 0) {
      lines.push("", `Skipped patches: ${composition.skipped.length}`, "");
      for (const skipped of composition.skipped) {
        lines.push(`- \`${skipped.agent}\`: ${skipped.reason}`);
      }
    }
    if (generatedFiles.length > 0) {
      lines.push("", `Generated files: ${generatedFiles.length}`, "");
      for (const generated of generatedFiles) {
        lines.push(`- \`${generated.path}\` from ${generated.count} ${generated.type} item${generated.count === 1 ? "" : "s"}`);
      }
    }
  } else {
    lines.push("Not run yet.");
  }
  lines.push("");

  lines.push("## Verification", "");
  if (verification) {
    lines.push(`Status: \`${verification.status}\``, "");
    if (verification.commands.length === 0) {
      lines.push("No verification commands were configured.");
    } else {
      lines.push("| Status | Command | Duration | Log |", "|---|---|---:|---|");
      for (const command of verification.commands) {
        lines.push(`| ${command.status} | \`${escapeTable(command.command)}\` | ${command.durationMs}ms | \`${command.logPath}\` |`);
      }
    }
  } else {
    lines.push("Not run yet.");
  }
  lines.push("");

  lines.push("## Artifacts", "");
  lines.push(`- Run summary: \`${join(run.runPath, "summary.json")}\``);
  lines.push(`- Task plan: \`${join(run.runPath, "task-plan.yml")}\``);
  for (const agent of run.agents) {
    lines.push(`- \`${agent.agent}\` log: \`${agent.logPath}\``);
    lines.push(`- \`${agent.agent}\` patch: \`${agent.patchPath}\``);
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}

async function readOptionalJson<S extends z.ZodTypeAny>(path: string, schema: S): Promise<z.output<S> | undefined> {
  if (!(await pathExists(path))) {
    return undefined;
  }

  return schema.parse(JSON.parse(await readFile(path, "utf8")));
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

function escapeTable(value: string): string {
  return value.replaceAll("|", "\\|");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
