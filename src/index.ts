#!/usr/bin/env node

import { Command } from "commander";

const program = new Command();

program
  .name("agentx")
  .description("Coordinate multiple coding agents with isolated workspaces and ownership checks.")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize AgentX metadata in the current repository.")
  .action(() => {
    console.log("agentx init: not implemented yet");
  });

program
  .command("validate-plan")
  .argument("<plan>", "Path to a task-plan.yml file")
  .description("Validate an AgentX task plan.")
  .action((plan: string) => {
    console.log(`agentx validate-plan: not implemented yet (${plan})`);
  });

program
  .command("run")
  .argument("<plan>", "Path to a task-plan.yml file")
  .description("Run agents from a task plan in isolated worktrees.")
  .action((plan: string) => {
    console.log(`agentx run: not implemented yet (${plan})`);
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
