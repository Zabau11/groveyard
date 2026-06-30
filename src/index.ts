#!/usr/bin/env node

import { Command } from "commander";
import { composeRun } from "./commands/compose.js";
import { initAgentx } from "./commands/init.js";
import { generateReport } from "./commands/report.js";
import { runPlanFile } from "./commands/run.js";
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
  .command("run")
  .argument("<plan>", "Path to a task-plan.yml file")
  .description("Run agents from a task plan in isolated worktrees.")
  .action(async (plan: string) => {
    const summary = await runPlanFile(plan, process.cwd());

    console.log(`Run complete: ${summary.runId}`);
    console.log(`Status: ${summary.status}`);
    console.log(`Run directory: ${summary.runPath}`);
    console.log("");
    for (const agent of summary.agents) {
      console.log(`- ${agent.agent}: ${agent.status} (${agent.changedFiles.length} changed files)`);
      if (agent.violations.length > 0) {
        for (const violation of agent.violations) {
          console.log(`  - ${violation}`);
        }
      }
    }
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

program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
});
