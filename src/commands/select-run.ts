import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { listRunStatuses, type RunStatusListItem } from "./status.js";

export type RunSelectionKind = "any" | "composable" | "composed";

type SelectRunOptions = {
  kind: RunSelectionKind;
  action: string;
};

export async function selectRun(cwd: string, options: SelectRunOptions): Promise<string> {
  const runs = filterRuns(await listRunStatuses(cwd), options.kind).reverse();
  if (runs.length === 0) {
    throw new Error(noRunsMessage(options.kind, options.action));
  }

  if (!process.stdin.isTTY) {
    throw new Error(`No --run provided and stdin is not interactive. Available runs:\n${formatRunChoices(runs)}`);
  }

  console.log(`Select a run to ${options.action}:`);
  console.log(formatRunChoices(runs));

  const rl = createInterface({ input, output });
  try {
    while (true) {
      const answer = (await rl.question("Run number: ")).trim();
      const selected = Number.parseInt(answer, 10);
      if (Number.isInteger(selected) && selected >= 1 && selected <= runs.length) {
        return runs[selected - 1]!.runId;
      }
      console.log(`Enter a number from 1 to ${runs.length}.`);
    }
  } finally {
    rl.close();
  }
}

function filterRuns(runs: RunStatusListItem[], kind: RunSelectionKind): RunStatusListItem[] {
  switch (kind) {
    case "any":
      return runs;
    case "composable":
      return runs.filter((run) => !run.composed && run.accepted > 0);
    case "composed":
      return runs.filter((run) => run.composed);
  }
}

function formatRunChoices(runs: RunStatusListItem[]): string {
  return runs.map((run, index) => `${index + 1}. ${formatRunChoice(run)}`).join("\n");
}

function formatRunChoice(run: RunStatusListItem): string {
  return `${run.runId} (${run.status}, agents=${run.agents}, accepted=${run.accepted}, composed=${run.composed ? "yes" : "no"}, verification=${run.verified})`;
}

function noRunsMessage(kind: RunSelectionKind, action: string): string {
  switch (kind) {
    case "any":
      return `No AgentX runs found to ${action}.`;
    case "composable":
      return `No uncomposed AgentX runs with accepted agents found. Run agentx start first, or pass --run <run-id>.`;
    case "composed":
      return `No composed AgentX runs found. Run agentx compose first, or pass --run <run-id>.`;
  }
}
