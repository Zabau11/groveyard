#!/usr/bin/env node

import { Command } from "commander";
import { analyzeRepository } from "./commands/analyze.js";
import { detectAutoAdapter, listAdapters } from "./commands/adapters.js";
import { bootstrapRepository } from "./commands/bootstrap.js";
import { cleanRun } from "./commands/clean.js";
import { composeRun } from "./commands/compose.js";
import { runDoctor, type DoctorStatus } from "./commands/doctor.js";
import { initAgentx } from "./commands/init.js";
import { createDraftPlan, previewDraftPlan } from "./commands/plan.js";
import { generateReport } from "./commands/report.js";
import { runPlanFile, type RunProgressEvent } from "./commands/run.js";
import { getRunStatus, listRunStatuses } from "./commands/status.js";
import { validatePlanFile } from "./commands/validate-plan.js";
import { verifyRun } from "./commands/verify.js";

const program = new Command();

program
  .name("agentx")
  .description("Coordinate multiple coding agents with isolated workspaces and ownership checks.")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize AgentX metadata in the current repository.")
  .action(async () => {
    const result = await initAgentx(process.cwd());

    console.log("Initialized AgentX metadata.");
    if (result.created.length > 0) {
      console.log("\nCreated:");
      for (const path of result.created) {
        console.log(`  - ${path}`);
      }
    }

    if (result.skipped.length > 0) {
      console.log("\nAlready existed:");
      for (const path of result.skipped) {
        console.log(`  - ${path}`);
      }
    }
  });

program
  .command("analyze")
  .description("Analyze the current repository and write .agentx/analysis.json.")
  .action(async () => {
    const analysis = await analyzeRepository(process.cwd());

    console.log("Repository analysis complete.");
    console.log(`Package manager: ${analysis.packageManager}`);
    console.log(`Verify commands: ${analysis.verify.length}`);
    for (const command of analysis.verify) {
      console.log(`- ${command}`);
    }
    console.log(`Modules: ${analysis.modules.length}`);
    for (const module of analysis.modules) {
      console.log(`- ${module.kind}: ${module.path}`);
    }
    console.log(`Shared files: ${analysis.sharedFiles.length}`);
    console.log("Wrote: .agentx/analysis.json");
  });

program
  .command("bootstrap")
  .description("Create a minimal TypeScript app skeleton with AgentX-friendly ownership lanes.")
  .action(async () => {
    const result = await bootstrapRepository(process.cwd());

    console.log("Bootstrap complete.");
    console.log(`Created: ${result.created.length}`);
    for (const path of result.created) {
      console.log(`- ${path}`);
    }
    if (result.skipped.length > 0) {
      console.log(`Skipped existing: ${result.skipped.length}`);
      for (const path of result.skipped) {
        console.log(`- ${path}`);
      }
    }
    if (result.needsInstall) {
      console.log("Dependency install needed before verification: npm install");
    }
    if (result.created.length > 0) {
      console.log("Next: install dependencies, commit the scaffold, then run agentx start.");
    }
  });

program
  .command("adapters")
  .option("--detect", "Show which adapter auto would select")
  .description("List configured AgentX adapter presets.")
  .action(async (options: { detect?: boolean }) => {
    const adapters = await listAdapters(process.cwd());
    if (adapters.length === 0) {
      console.log("No adapters configured.");
      return;
    }

    console.log("Configured adapters:");
    for (const adapter of adapters) {
      console.log(`- ${adapter.name} (${adapter.type})`);
      if (adapter.commandTemplate) {
        console.log(`  commandTemplate: ${adapter.commandTemplate}`);
      }
      if (adapter.description) {
        console.log(`  ${adapter.description}`);
      }
    }

    if (options.detect) {
      console.log("");
      const detection = await detectAutoAdapter(process.cwd());
      console.log(`Auto selection: ${detection.selected ?? "none"}`);
      for (const candidate of detection.candidates) {
        console.log(`- ${candidate.name}: ${candidate.available ? "available" : "missing"}${candidate.command ? ` (${candidate.command})` : ""}`);
      }
    }
  });

program
  .command("doctor")
  .option("--strict", "Exit non-zero when warnings are present")
  .description("Check whether the current repository is ready for AgentX.")
  .action(async (options: { strict?: boolean }) => {
    const report = await runDoctor(process.cwd());

    console.log(`AgentX doctor: ${report.status}`);
    for (const section of report.sections) {
      console.log("");
      console.log(section.title);
      for (const check of section.checks) {
        console.log(`${statusIcon(check.status)} ${check.label}: ${check.detail}`);
        if (check.fix) {
          console.log(`  fix: ${check.fix}`);
        }
      }
    }

    if (report.status === "blocked" || (options.strict && report.status !== "ready")) {
      process.exitCode = 1;
    }
  });

program
  .command("validate-plan")
  .argument("<plan>", "Path to a task-plan.yml file")
  .description("Validate an AgentX task plan.")
  .action(async (plan: string) => {
    const result = await validatePlanFile(plan, process.cwd());
    const agentCount = Object.keys(result.plan.agents).length;

    console.log(`Task plan is valid: ${plan}`);
    console.log(`Run: ${result.plan.runId}`);
    console.log(`Base branch: ${result.plan.baseBranch}`);
    console.log(`Agents: ${agentCount}`);

    if (result.warnings.length > 0) {
      console.log("\nWarnings:");
      for (const warning of result.warnings) {
        console.log(`  - ${warning}`);
      }
    }
  });

program
  .command("plan")
  .argument("<goal...>", "Goal to turn into a draft task plan")
  .option("--adapter <name>", "Adapter preset to use", "auto")
  .option("--out <path>", "Output path", ".agentx/task-plan.yml")
  .description("Generate a conservative draft task plan from repository analysis.")
  .action(async (goalParts: string[], options: { adapter: string; out: string }) => {
    const goal = goalParts.join(" ");
    const result = await createDraftPlan(goal, process.cwd(), { adapter: options.adapter, out: options.out });

    console.log(`Draft task plan generated: ${result.path}`);
    console.log(`Run: ${result.runId}`);
    console.log(`Agents: ${result.agentCount}`);
    console.log("");
    for (const line of result.rationale) {
      console.log(`- ${line}`);
    }
  });

program
  .command("preview")
  .argument("<goal...>", "Goal to preview without running agents")
  .option("--adapter <name>", "Adapter preset to use", "auto")
  .description("Preview the AgentX orchestration plan without writing files or creating worktrees.")
  .action(async (goalParts: string[], options: { adapter: string }) => {
    const goal = goalParts.join(" ");
    const preview = await previewDraftPlan(goal, process.cwd(), { adapter: options.adapter });

    console.log("AgentX preview");
    console.log("");
    console.log(`Goal: ${preview.goal}`);
    console.log(`Run ID: ${preview.plan.runId}`);
    console.log(`Base branch: ${preview.plan.baseBranch}`);
    console.log("");

    console.log("Agents");
    for (const [agentName, agent] of Object.entries(preview.plan.agents)) {
      console.log(`- ${agentName}`);
      console.log(`  adapter: ${agent.adapter}`);
      console.log(`  owns: ${agent.owns.join(", ")}`);
      if (agent.mayRead.length > 0) {
        console.log(`  may read: ${agent.mayRead.join(", ")}`);
      }
      if (agent.forbidden.length > 0) {
        console.log(`  forbidden: ${agent.forbidden.slice(0, 6).join(", ")}${agent.forbidden.length > 6 ? ", ..." : ""}`);
      }
    }

    console.log("");
    console.log("Composition");
    if (preview.plan.generators.routes) {
      console.log(`- routes: generate ${preview.plan.generators.routes.output} from accepted manifests`);
    } else {
      console.log("- no generators detected");
    }

    console.log("");
    console.log("Verification");
    if (preview.plan.verify.length > 0) {
      for (const command of preview.plan.verify) {
        console.log(`- ${command}`);
      }
    } else {
      console.log("- no verification commands detected");
    }

    console.log("");
    console.log("Adapter");
    if (options.adapter === "auto") {
      try {
        const detection = await detectAutoAdapter(process.cwd());
        console.log(`- auto selection: ${detection.selected ?? "none"}`);
        for (const candidate of detection.candidates) {
          console.log(`- ${candidate.name}: ${candidate.available ? "available" : "missing"}${candidate.command ? ` (${candidate.command})` : ""}`);
        }
      } catch (error) {
        console.log(`- auto detection unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      console.log(`- ${options.adapter}`);
    }

    console.log("");
    console.log("Notes");
    for (const line of preview.rationale) {
      console.log(`- ${line}`);
    }
    console.log("- Preview only. No files were written and no agents were run.");
  });

program
  .command("start")
  .argument("<goal...>", "Goal to plan, run, compose, verify, and report")
  .option("--adapter <name>", "Adapter preset to use", "auto")
  .option("--bootstrap", "Create a minimal TypeScript app skeleton before planning")
  .option("--out <path>", "Output path for the generated task plan", ".agentx/task-plan.yml")
  .option("--no-compose", "Skip composition")
  .option("--no-verify", "Skip verification")
  .option("--no-report", "Skip report generation")
  .option("--verbose", "Show adapter commands, workspaces, and live agent output")
  .description("Run the one-command AgentX flow from goal to report.")
  .action(async (goalParts: string[], options: { adapter: string; bootstrap?: boolean; out: string; compose: boolean; verify: boolean; report: boolean; verbose?: boolean }) => {
    const goal = goalParts.join(" ");
    let skipVerifyReason: string | undefined;
    if (options.bootstrap) {
      const bootstrap = await bootstrapRepository(process.cwd());
      console.log(`Bootstrap complete: created=${bootstrap.created.length}, skipped=${bootstrap.skipped.length}`);
      if (bootstrap.created.length > 0) {
        console.log("");
        console.log("Bootstrap created new files. Commit the scaffold before running agents so AgentX worktrees can use it as the base.");
        console.log("Next:");
        console.log("- npm install");
        console.log("- git add . && git commit -m \"bootstrap app\"");
        console.log(`- agentx start "${goal}" --adapter ${options.adapter}`);
        return;
      }
      if (bootstrap.needsInstall) {
        skipVerifyReason = "Skipping verification because dependencies are not installed yet. Run npm install before verifying.";
      }
      console.log("");
    }

    const plan = await createDraftPlan(goal, process.cwd(), { adapter: options.adapter, out: options.out });

    console.log(`Plan: ${plan.runId} (${formatCount(plan.agentCount, "agent")}, adapter=${options.adapter})`);
    if (options.verbose) {
      console.log(`Task plan: ${plan.path}`);
      for (const line of plan.rationale) {
        console.log(`- ${line}`);
      }
    }

    console.log("");
    const run = await runPlanFile(plan.path, process.cwd(), { onProgress: createRunProgressPrinter({ verbose: Boolean(options.verbose) }) });
    console.log(`Run: ${run.status}`);
    printAgentViolations(run.agents);

    if (!options.compose) {
      return;
    }

    console.log("");
    const composition = await composeRun(run.runId, process.cwd());
    console.log(`Compose: ${composition.status}`);
    if (options.verbose) {
      console.log(`Branch: ${composition.branch}`);
      console.log(`Workspace: ${composition.workspacePath}`);
    }

    if (options.verify && !skipVerifyReason) {
      console.log("");
      const verification = await verifyRun(run.runId, process.cwd());
      console.log(`Verify: ${verification.status}`);
      for (const command of verification.commands) {
        console.log(`- ${command.status}: ${command.command} (${command.durationMs}ms)`);
      }
    } else if (skipVerifyReason) {
      console.log("");
      console.log(skipVerifyReason);
    }

    if (options.report) {
      console.log("");
      const report = await generateReport(run.runId, process.cwd());
      console.log(`Report: ${report.reportPath}`);
    }
  });

program
  .command("run")
  .argument("<plan>", "Path to a task-plan.yml file")
  .option("--verbose", "Show adapter commands, workspaces, and live agent output")
  .description("Run agents from a task plan in isolated worktrees.")
  .action(async (plan: string, options: { verbose?: boolean }) => {
    const summary = await runPlanFile(plan, process.cwd(), { onProgress: createRunProgressPrinter({ verbose: Boolean(options.verbose) }) });

    console.log(`Run: ${summary.runId}`);
    console.log(`Status: ${summary.status}`);
    if (options.verbose) {
      console.log(`Run directory: ${summary.runPath}`);
    }
    printAgentViolations(summary.agents);
  });

program
  .command("status")
  .option("--run <runId>", "Run ID to inspect")
  .description("Show run status.")
  .action(async (options: { run?: string }) => {
    if (options.run) {
      const detail = await getRunStatus(options.run, process.cwd());
      console.log(`Run: ${detail.run.runId}`);
      console.log(`Status: ${detail.run.status}`);
      console.log(`Base branch: ${detail.run.baseBranch}`);
      console.log(`Agents: ${detail.run.agents.length}`);
      console.log("");
      for (const agent of detail.run.agents) {
        console.log(`- ${agent.agent}: ${agent.status} (${agent.changedFiles.length} changed files)`);
        for (const violation of agent.violations) {
          console.log(`  - ${violation}`);
        }
      }
      console.log("");
      console.log(`Composition: ${detail.composition ? detail.composition.status : "not_run"}`);
      if (detail.composition) {
        console.log(`Branch: ${detail.composition.branch}`);
        console.log(`Workspace: ${detail.composition.workspacePath}`);
      }
      console.log(`Verification: ${detail.verification ? detail.verification.status : "not_run"}`);
      console.log(`Report: ${detail.reportExists ? "generated" : "not_run"}`);
      return;
    }

    const runs = await listRunStatuses(process.cwd());
    if (runs.length === 0) {
      console.log("No AgentX runs found.");
      return;
    }

    console.log("AgentX runs:");
    for (const run of runs) {
      console.log(
        `- ${run.runId}: ${run.status}, agents=${run.agents}, accepted=${run.accepted}, rejected=${run.rejected}, failed=${run.failed}, composed=${run.composed ? "yes" : "no"}, verification=${run.verified}, report=${run.reported ? "yes" : "no"}`,
      );
    }
  });

program
  .command("clean")
  .requiredOption("--run <runId>", "Run ID to clean")
  .description("Remove run artifacts, worktrees, report copies, and the integration branch for a run.")
  .action(async (options: { run: string }) => {
    const result = await cleanRun(options.run, process.cwd());

    console.log(`Cleaned run: ${result.runId}`);
    console.log(`Removed worktrees: ${result.removedWorktrees.length}`);
    for (const worktree of result.removedWorktrees) {
      console.log(`- ${worktree}`);
    }
    console.log(`Removed paths: ${result.removedPaths.length}`);
    for (const path of result.removedPaths) {
      console.log(`- ${path}`);
    }
    if (result.deletedBranch) {
      console.log(`Deleted branch: ${result.deletedBranch}`);
    }
  });

program
  .command("compose")
  .requiredOption("--run <runId>", "Run ID to compose")
  .description("Compose accepted agent patches into an integration result.")
  .action(async (options: { run: string }) => {
    const summary = await composeRun(options.run, process.cwd());

    console.log(`Composition complete: ${summary.runId}`);
    console.log(`Status: ${summary.status}`);
    console.log(`Branch: ${summary.branch}`);
    console.log(`Workspace: ${summary.workspacePath}`);
    console.log("");
    console.log(`Applied: ${summary.applied.length}`);
    for (const applied of summary.applied) {
      console.log(`- ${applied.agent}: ${applied.changedFiles.length} changed files`);
    }
    if (summary.generatedFiles.length > 0) {
      console.log("");
      console.log(`Generated files: ${summary.generatedFiles.length}`);
      for (const generated of summary.generatedFiles) {
        console.log(`- ${generated.path}: ${generated.count} ${generated.type} item${generated.count === 1 ? "" : "s"}`);
      }
    }
    if (summary.skipped.length > 0) {
      console.log("");
      console.log(`Skipped: ${summary.skipped.length}`);
      for (const skipped of summary.skipped) {
        console.log(`- ${skipped.agent}: ${skipped.reason}`);
      }
    }
  });

program
  .command("verify")
  .requiredOption("--run <runId>", "Run ID to verify")
  .description("Run configured verification commands for a composed run.")
  .action(async (options: { run: string }) => {
    const summary = await verifyRun(options.run, process.cwd());

    console.log(`Verification complete: ${summary.runId}`);
    console.log(`Status: ${summary.status}`);
    console.log(`Workspace: ${summary.workspacePath}`);
    if (summary.commands.length > 0) {
      console.log("");
      for (const command of summary.commands) {
        console.log(`- ${command.status}: ${command.command} (${command.durationMs}ms)`);
      }
    }
  });

program
  .command("report")
  .requiredOption("--run <runId>", "Run ID to report on")
  .description("Generate or print a Markdown report for a run.")
  .action(async (options: { run: string }) => {
    const result = await generateReport(options.run, process.cwd());

    console.log(`Report generated: ${result.runId}`);
    console.log(`Run report: ${result.reportPath}`);
    console.log(`Report copy: ${result.mirrorPath}`);
  });

function statusIcon(status: DoctorStatus): string {
  switch (status) {
    case "pass":
      return "OK";
    case "warn":
      return "WARN";
    case "fail":
      return "FAIL";
    case "info":
      return "INFO";
  }
}

function createRunProgressPrinter(options: { verbose: boolean }): (event: RunProgressEvent) => void {
  let activeIndicator: AgentActivityIndicator | undefined;

  return (event) => {
    switch (event.type) {
      case "run_started":
        console.log(`Running ${formatCount(event.agentCount, "agent")}...`);
        if (options.verbose) {
          console.log(`Worktrees: ${event.worktreeRoot}`);
        }
        return;
      case "agent_started":
        activeIndicator?.stop();
        activeIndicator = new AgentActivityIndicator({
          agent: event.agent,
          focus: event.owns.join(", "),
          index: event.index,
          total: event.total,
          enabled: !options.verbose,
        });
        activeIndicator.start();
        if (options.verbose) {
          console.log(`- ${event.agent}: started (${event.index}/${event.total})`);
          console.log(`  working on: ${event.owns.join(", ")}`);
          console.log(`  workspace: ${event.workspacePath}`);
        }
        return;
      case "agent_command":
        if (options.verbose) {
          console.log(`  command: ${event.command}`);
        }
        return;
      case "agent_output":
        if (options.verbose) {
          writeAgentOutput(event.agent, event.chunk);
        }
        return;
      case "agent_finished":
        activeIndicator?.stop();
        activeIndicator = undefined;
        console.log(`- ${event.agent}: ${event.status} (${formatCount(event.changedFiles, "changed file")}, ${formatCount(event.violations, "violation")})`);
        if (options.verbose) {
          console.log(`  exit: ${event.exitCode}`);
          console.log(`  log: ${event.logPath}`);
        }
        return;
      case "run_finished":
        activeIndicator?.stop();
        activeIndicator = undefined;
        if (options.verbose) {
          console.log(`Summary: ${event.summaryPath}`);
        }
        return;
    }
  };
}

class AgentActivityIndicator {
  private frame = 0;
  private timer: NodeJS.Timeout | undefined;
  private lastLineLength = 0;

  constructor(private readonly input: { agent: string; focus: string; index: number; total: number; enabled: boolean }) {}

  start(): void {
    if (!this.input.enabled) {
      return;
    }

    if (!process.stdout.isTTY) {
      console.log(`- ${this.input.agent}: working on ${this.input.focus} (${this.input.index}/${this.input.total})`);
      return;
    }

    this.render();
    this.timer = setInterval(() => this.render(), 400);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    if (this.input.enabled && process.stdout.isTTY && this.lastLineLength > 0) {
      process.stdout.write(`\r${" ".repeat(this.lastLineLength)}\r`);
      this.lastLineLength = 0;
    }
  }

  private render(): void {
    const dots = ".".repeat((this.frame % 4) + 1);
    this.frame += 1;
    const line = `- ${this.input.agent}: working on ${this.input.focus}${dots} (${this.input.index}/${this.input.total})`;
    this.lastLineLength = Math.max(this.lastLineLength, line.length);
    process.stdout.write(`\r${line}${" ".repeat(Math.max(0, this.lastLineLength - line.length))}`);
  }
}

function writeAgentOutput(agent: string, chunk: string): void {
  for (const line of chunk.split(/\r?\n/)) {
    if (line.length === 0) {
      continue;
    }
    process.stdout.write(`[${agent}] ${line}\n`);
  }
}

function printAgentViolations(agents: Array<{ agent: string; violations: string[] }>): void {
  const agentsWithViolations = agents.filter((agent) => agent.violations.length > 0);
  if (agentsWithViolations.length === 0) {
    return;
  }

  console.log("");
  console.log("Issues:");
  for (const agent of agentsWithViolations) {
    console.log(`- ${agent.agent}`);
    for (const violation of agent.violations) {
      console.log(`  - ${violation}`);
    }
  }
}

function formatCount(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
});
