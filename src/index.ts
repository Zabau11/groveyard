#!/usr/bin/env node

import { Command } from "commander";
import { initAgentx } from "./commands/init.js";
import { runPlanFile } from "./commands/run.js";
import { validatePlanFile } from "./commands/validate-plan.js";

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
  .action((options: { run?: string }) => {
    console.log(`agentx status: not implemented yet${options.run ? ` (${options.run})` : ""}`);
  });

program
  .command("compose")
  .requiredOption("--run <runId>", "Run ID to compose")
  .description("Compose accepted agent patches into an integration result.")
  .action((options: { run: string }) => {
    console.log(`agentx compose: not implemented yet (${options.run})`);
  });

program
  .command("verify")
  .requiredOption("--run <runId>", "Run ID to verify")
  .description("Run configured verification commands for a composed run.")
  .action((options: { run: string }) => {
    console.log(`agentx verify: not implemented yet (${options.run})`);
  });

program
  .command("report")
  .requiredOption("--run <runId>", "Run ID to report on")
  .description("Generate or print a Markdown report for a run.")
  .action((options: { run: string }) => {
    console.log(`agentx report: not implemented yet (${options.run})`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
});
