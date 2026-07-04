import { stdin as input, stdout as output } from "node:process";
import { readFile } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline/promises";
import { composeRun } from "./compose.js";
import { createDraftPlan, previewDraftPlan, type DraftPlanPreview } from "./plan.js";
import { parsePlannerMode, type PlannerMode } from "./planner.js";
import { generateReport } from "./report.js";
import { runPlanFile, type RunProgressEvent } from "./run.js";
import { runDoctor } from "./doctor.js";
import { listRunStatuses } from "./status.js";
import { verifyRun } from "./verify.js";

type TuiOptions = {
  cwd: string;
};

type ConsoleIntent =
  | { type: "new"; goal?: string }
  | { type: "explain"; goal?: string }
  | { type: "runs" }
  | { type: "doctor" }
  | { type: "help" }
  | { type: "exit" };

type HomeModel = {
  doctorStatus: string;
  runCount: number;
  latestRun?: string;
  planner: string;
};

const styles = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  gray: "\x1b[90m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  inverse: "\x1b[7m",
};

export async function launchTui(options: TuiOptions): Promise<void> {
  if (!input.isTTY || !output.isTTY) {
    console.log("AgentX Console needs an interactive terminal.");
    console.log("Run agentx --help to use the scriptable CLI.");
    return;
  }

  const rl = createInterface({ input, output });
  try {
    let exit = false;
    while (!exit) {
      await renderHome(options.cwd);
      const intent = parseConsoleIntent(await ask(rl, "What should AgentX do?"));
      switch (intent.type) {
        case "new":
          await newTaskFlow(rl, options.cwd, intent.goal);
          break;
        case "explain":
          await explainFlow(rl, options.cwd, intent.goal);
          break;
        case "runs":
          await runsFlow(rl, options.cwd);
          break;
        case "doctor":
          await doctorFlow(rl, options.cwd);
          break;
        case "help":
          await helpFlow(rl);
          break;
        case "exit":
          exit = true;
          break;
      }
    }
  } finally {
    rl.close();
  }
}

async function newTaskFlow(rl: Interface, cwd: string, initialGoal?: string): Promise<void> {
  clear();
  screen("New task", ["Describe the outcome. AgentX plans lanes before it touches worktrees."]);
  const goal = initialGoal?.trim() || (await ask(rl, "Task")).trim();
  if (!goal) {
    await pause(rl, "No task entered.");
    return;
  }

  const planner = await askPlanner(rl);
  const adapter = await askDefault(rl, "Adapter", "auto");

  const preview = await loadPreview(goal, cwd, { adapter, planner });
  renderExplain(preview);
  const shouldRun = await askYesNo(rl, "Run this now?", true);
  if (!shouldRun) {
    await pause(rl, `Ready when you are: agentx run ${shellDisplayQuote(goal)}`);
    return;
  }

  await runTask(goal, cwd, { adapter, planner });
  await pause(rl);
}

async function explainFlow(rl: Interface, cwd: string, initialGoal?: string): Promise<void> {
  clear();
  screen("Explain", ["Preview how AgentX would split and verify a task. No files are written."]);
  const goal = initialGoal?.trim() || (await ask(rl, "Task")).trim();
  if (!goal) {
    await pause(rl, "No task entered.");
    return;
  }

  const planner = await askPlanner(rl);
  const adapter = await askDefault(rl, "Adapter", "auto");
  const preview = await loadPreview(goal, cwd, { adapter, planner });
  renderExplain(preview);
  await pause(rl);
}

async function helpFlow(rl: Interface): Promise<void> {
  clear();
  screen("How to talk to AgentX", [
    "Type a task directly to plan and run it.",
    "Prefix with explain when you only want a preview.",
    "Use runs, doctor, help, or quit for console actions.",
  ]);
  section("Examples");
  commandExample("add retry support for failed agents", "plan and run");
  commandExample("explain add retry support for failed agents", "preview only");
  commandExample("new split settings into its own module", "guided run");
  commandExample("runs", "recent run state");
  commandExample("doctor", "repo readiness");
  console.log("");
  await pause(rl);
}

async function runsFlow(rl: Interface, cwd: string): Promise<void> {
  clear();
  const runs = await listRunStatuses(cwd);
  if (runs.length === 0) {
    screen("Runs", ["No saved AgentX runs yet."]);
    await pause(rl);
    return;
  }

  screen("Runs", ["Recent orchestration history."]);
  for (const run of runs.slice(-12)) {
    console.log(`${statusPill(run.status)} ${bold(truncate(run.runId, 56))}`);
    console.log(`  ${muted(`agents ${run.agents}`)}  ${muted(`accepted ${run.accepted}`)}  ${muted(`verify ${run.verified}`)}  ${muted(run.composed ? "composed" : "not composed")}`);
  }
  console.log("");
  console.log(muted("Use agentx status, agentx apply, or agentx clean for run actions."));
  await pause(rl);
}

async function doctorFlow(rl: Interface, cwd: string): Promise<void> {
  clear();
  const report = await runDoctor(cwd);
  screen("Doctor", [`Repository status: ${report.status}`]);
  for (const section of report.sections) {
    sectionTitle(section.title);
    for (const check of section.checks) {
      console.log(`${statusPill(check.status)} ${bold(check.label)} ${muted(check.detail)}`);
      if (check.fix) {
        console.log(`  ${muted(`fix: ${check.fix}`)}`);
      }
    }
    console.log("");
  }
  await pause(rl);
}

async function loadPreview(goal: string, cwd: string, options: { adapter: string; planner: PlannerMode }): Promise<DraftPlanPreview> {
  clear();
  screen("Planning", [`Thinking through: ${goal}`]);
  console.log(`${spinnerFrame(0)} ${muted("reading repository shape and selecting lanes")}`);
  return previewDraftPlan(goal, cwd, options);
}

function renderExplain(preview: DraftPlanPreview): void {
  clear();
  const agents = Object.entries(preview.plan.agents);
  screen("AgentX Plan", [
    `Task: ${preview.goal}`,
    `${agents.length} agent${agents.length === 1 ? "" : "s"} selected by ${plannerLabel(preview)}`,
  ]);

  section("Execution lanes");
  for (const [agentName, agent] of agents) {
    console.log(`${lanePill(agentName)} ${muted("owns")} ${agent.owns.join(", ")}`);
    const reason = preview.planner.reason && agents.length === 1 ? preview.planner.reason : `This lane owns ${agent.owns.join(", ")}.`;
    detailRow("reason", reason);
    if (agent.forbidden.length > 0) {
      detailRow("protects", `${agent.forbidden.slice(0, 5).join(", ")}${agent.forbidden.length > 5 ? ", ..." : ""}`);
    }
    console.log("");
  }

  if (preview.planner.warning) {
    console.log(warnLine(`Planner note: ${preview.planner.warning}`));
    console.log("");
  }

  section("Verification");
  if (preview.plan.verify.length > 0) {
    for (const command of preview.plan.verify) {
      console.log(`  ${muted("$")} ${command}`);
    }
  } else {
    console.log(`  ${muted("none detected")}`);
  }
  console.log("");
}

async function runTask(goal: string, cwd: string, options: { adapter: string; planner: PlannerMode }): Promise<void> {
  clear();
  screen("Launch", [`Creating plan for: ${goal}`]);
  const plan = await createDraftPlan(goal, cwd, { adapter: options.adapter, planner: options.planner });
  console.log(`${statusPill("ready")} ${bold("Plan ready")} ${muted(plan.runId)}`);
  console.log("");

  const run = await runPlanFile(plan.path, cwd, { onProgress: createTuiProgressPrinter() });
  console.log("");
  console.log(`${statusPill(run.status)} ${bold("Run")} ${run.status}`);
  printViolations(run.agents);

  console.log("");
  section("Compose");
  const composition = await composeRun(run.runId, cwd);
  console.log(`${statusPill(composition.status)} ${composition.status}`);

  console.log("");
  section("Verify");
  const verification = await verifyRun(run.runId, cwd);
  console.log(`${statusPill(verification.status)} ${verification.status}`);
  for (const command of verification.commands) {
    const commandStatus = "status" in command && typeof command.status === "string" ? command.status : "done";
    const commandText = "command" in command && typeof command.command === "string" ? command.command : "verification command";
    console.log(`  ${statusPill(commandStatus)} ${commandText}`);
  }

  console.log("");
  const report = await generateReport(run.runId, cwd);
  console.log(`${statusPill("ready")} ${bold("Report")} ${report.reportPath}`);
  console.log("");
  section("Next");
  commandExample(`agentx apply --run ${run.runId}`, "bring changes back");
  commandExample(`agentx status --run ${run.runId}`, "inspect result");
}

function createTuiProgressPrinter(): (event: RunProgressEvent) => void {
  return (event) => {
    switch (event.type) {
      case "run_started":
        console.log(`${spinnerFrame(0)} ${bold(`Running ${event.agentCount} agent${event.agentCount === 1 ? "" : "s"}`)}`);
        return;
      case "agent_started":
        console.log(`  ${lanePill(event.agent)} ${muted("working on")} ${event.owns.join(", ")}`);
        return;
      case "agent_activity":
        console.log(`    ${spinnerFrame(1)} ${muted(event.activity)}`);
        return;
      case "agent_finished":
        console.log(`  ${statusPill(event.status)} ${event.agent} ${muted(`changed ${event.changedFiles}, violations ${event.violations}`)}`);
        return;
      case "run_finished":
      case "agent_command":
      case "agent_output":
        return;
    }
  };
}

async function renderHome(cwd: string): Promise<void> {
  const model = await loadHomeModel(cwd);
  clear();
  const width = contentWidth();
  console.log(accentRule(width));
  console.log(`${brand()} ${muted("Task-native orchestration for coding agents")}`);
  console.log(accentRule(width));
  console.log("");
  twoColumns(
    [
      `${panelTitle("Command Center")}`,
      `${muted("Type a task directly. AgentX handles the workflow.")}`,
      "",
      `${primaryCommand("add retry support for failed agents")}`,
      `${secondaryCommand("explain add retry support for failed agents")}`,
      "",
      `${actionLabel("new")} ${muted("guided task launch")}`,
      `${actionLabel("runs")} ${muted("recent orchestration history")}`,
      `${actionLabel("doctor")} ${muted("repository readiness")}`,
      `${actionLabel("quit")} ${muted("leave the console")}`,
    ],
    [
      `${panelTitle("Workspace")}`,
      `${statusPill(model.doctorStatus)} ${muted("doctor")}`,
      `${statusPill(model.planner === "mistral" ? "llm" : "local")} ${muted(`planner ${model.planner}`)}`,
      `${statusPill(model.runCount > 0 ? "info" : "ready")} ${muted(`${model.runCount} saved run${model.runCount === 1 ? "" : "s"}`)}`,
      "",
      `${panelTitle("Flow")}`,
      `${stepLine("1", "plan lanes")}`,
      `${stepLine("2", "run adapters")}`,
      `${stepLine("3", "compose changes")}`,
      `${stepLine("4", "verify result")}`,
      model.latestRun ? `${muted(`latest ${truncate(model.latestRun, 30)}`)}` : muted("latest no saved runs yet"),
    ],
  );
  console.log("");
  console.log(`${muted("Use")} ${cyan("help")} ${muted("for examples, or type the change you want below.")}`);
  console.log("");
}

async function loadHomeModel(cwd: string): Promise<HomeModel> {
  const [doctor, runs] = await Promise.all([
    runDoctor(cwd).catch(() => undefined),
    listRunStatuses(cwd).catch(() => []),
  ]);
  return {
    doctorStatus: doctor?.status ?? "unknown",
    runCount: runs.length,
    latestRun: runs.at(-1)?.runId,
    planner: await detectPlannerLabel(cwd),
  };
}

async function detectPlannerLabel(cwd: string): Promise<string> {
  const env = { ...process.env };
  try {
    const raw = await readFile(`${cwd}/.env`, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const separator = trimmed.indexOf("=");
      if (separator === -1) {
        continue;
      }
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key && !(key in env)) {
        env[key] = value;
      }
    }
  } catch {
    // Missing or unreadable .env should not block the console.
  }

  return env.AGENTX_PLANNER_PROVIDER === "mistral" || env.MISTRAL_API_KEY ? "mistral" : "local";
}

function parseConsoleIntent(raw: string): ConsoleIntent {
  const value = raw.trim();
  const lower = value.toLowerCase();
  if (!value) {
    return { type: "help" };
  }

  if (["q", "quit", "exit", "close"].includes(lower)) {
    return { type: "exit" };
  }
  if (["help", "?", "h"].includes(lower)) {
    return { type: "help" };
  }
  if (["runs", "run list", "history", "status"].includes(lower)) {
    return { type: "runs" };
  }
  if (["doctor", "check", "health"].includes(lower)) {
    return { type: "doctor" };
  }

  const explainMatch = value.match(/^(explain|preview|plan)\s+(.+)$/i);
  if (explainMatch?.[2]) {
    return { type: "explain", goal: explainMatch[2].trim() };
  }
  if (["explain", "preview", "plan"].includes(lower)) {
    return { type: "explain" };
  }

  const newMatch = value.match(/^(new|run|start)\s+(.+)$/i);
  if (newMatch?.[2]) {
    return { type: "new", goal: newMatch[2].trim() };
  }
  if (["new", "run", "start"].includes(lower)) {
    return { type: "new" };
  }

  return { type: "new", goal: value };
}

async function askPlanner(rl: Interface): Promise<PlannerMode> {
  while (true) {
    const value = await askDefault(rl, "Planner", "auto");
    try {
      return parsePlannerMode(value);
    } catch (error) {
      console.log(red(error instanceof Error ? error.message : String(error)));
    }
  }
}

async function askDefault(rl: Interface, label: string, defaultValue: string): Promise<string> {
  const answer = (await ask(rl, `${label} (${defaultValue})`)).trim();
  return answer || defaultValue;
}

async function askYesNo(rl: Interface, question: string, defaultValue: boolean): Promise<boolean> {
  const suffix = defaultValue ? "Y/n" : "y/N";
  const answer = (await ask(rl, `${question} [${suffix}]`)).trim().toLowerCase();
  if (!answer) {
    return defaultValue;
  }
  return answer === "y" || answer === "yes";
}

async function pause(rl: Interface, message = "Press Enter to continue."): Promise<void> {
  await ask(rl, message);
}

async function ask(rl: Interface, label: string): Promise<string> {
  return rl.question(`${styles.inverse}${styles.bold} AGENTX ${styles.reset} ${muted(label)} ${cyan(">")} `);
}

function screen(title: string, lines: string[]): void {
  const width = contentWidth();
  console.log(accentRule(width));
  console.log(`${brand()} ${muted("/")} ${cyan(title)}`);
  console.log(accentRule(width));
  for (const line of lines) {
    console.log(muted(line));
  }
  console.log("");
}

function twoColumns(left: string[], right: string[]): void {
  const width = contentWidth();
  const gap = 4;
  const leftWidth = Math.max(42, Math.floor((width - gap) * 0.62));
  const rightWidth = Math.max(24, width - leftWidth - gap);
  const rows = Math.max(left.length, right.length);
  for (let index = 0; index < rows; index += 1) {
    const leftCell = padVisible(left[index] ?? "", leftWidth);
    const rightCell = padVisible(right[index] ?? "", rightWidth);
    console.log(`${leftCell}${" ".repeat(gap)}${rightCell}`);
  }
}

function brand(): string {
  return `${styles.inverse}${styles.bold} AGENTX ${styles.reset}`;
}

function accentRule(width: number): string {
  return `${styles.blue}${"=".repeat(width)}${styles.reset}`;
}

function panelTitle(value: string): string {
  return `${styles.bold}${value}${styles.reset}`;
}

function primaryCommand(value: string): string {
  return `${styles.inverse}${styles.bold} RUN ${styles.reset} ${value}`;
}

function secondaryCommand(value: string): string {
  return `${styles.blue}${styles.bold} EXPLAIN ${styles.reset} ${value}`;
}

function actionLabel(value: string): string {
  return `${cyan(value.padEnd(8))}`;
}

function stepLine(step: string, label: string): string {
  return `${styles.blue}${styles.bold}${step}${styles.reset} ${label}`;
}

function section(title: string): void {
  console.log(sectionHeading(title));
}

function sectionTitle(title: string): void {
  console.log(sectionHeading(title));
}

function sectionHeading(title: string): string {
  return `${styles.blue}${"=".repeat(3)}${styles.reset} ${bold(title)}`;
}

function detailRow(label: string, value: string): void {
  console.log(`  ${muted(label.padEnd(8))} ${value}`);
}

function commandExample(command: string, description: string): void {
  console.log(`  ${cyan(command)} ${muted(description)}`);
}

function actionRow(command: string, description: string): void {
  console.log(`  ${cyan(command.padEnd(9))}${description}`);
}

function lanePill(value: string): string {
  return `${styles.blue}${styles.bold}[${value}]${styles.reset}`;
}

function statusPill(status: string): string {
  const normalized = status.toLowerCase();
  const label = normalized === "needs_attention" ? "ATTN" : normalized === "llm" ? "LLM" : normalized === "local" ? "LOCAL" : status.toUpperCase();
  const color =
    normalized === "pass" ||
    normalized === "passed" ||
    normalized === "ready" ||
    normalized === "accepted" ||
    normalized === "completed" ||
    normalized === "composed" ||
    normalized === "llm"
      ? styles.green
      : normalized === "warn" || normalized === "needs_attention" || normalized.includes("skip") || normalized.includes("rejection")
        ? styles.yellow
        : normalized === "info" || normalized === "done" || normalized === "local"
          ? styles.blue
          : styles.red;
  return `${color}${styles.bold}[${label}]${styles.reset}`;
}

function plannerLabel(preview: DraftPlanPreview): string {
  const confidence = typeof preview.planner.confidence === "number" ? `, ${Math.round(preview.planner.confidence * 100)}% confidence` : "";
  return `${preview.planner.source}${confidence}`;
}

function warnLine(value: string): string {
  return `${styles.yellow}${styles.bold}[NOTE]${styles.reset} ${value}`;
}

function spinnerFrame(frame: number): string {
  return cyan(["[.  ]", "[.. ]", "[...]"][frame % 3] ?? "[...]");
}

function truncate(value: string, length: number): string {
  if (value.length <= length) {
    return value;
  }
  return `${value.slice(0, Math.max(0, length - 3))}...`;
}

function contentWidth(): number {
  return Math.max(56, Math.min(92, output.columns ? output.columns - 4 : 80));
}

function padVisible(value: string, width: number): string {
  const length = visibleLength(value);
  if (length >= width) {
    return value;
  }
  return `${value}${" ".repeat(width - length)}`;
}

function visibleLength(value: string): number {
  return value.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function printViolations(agents: Array<{ agent: string; violations: string[] }>): void {
  const withViolations = agents.filter((agent) => agent.violations.length > 0);
  if (withViolations.length === 0) {
    return;
  }

  console.log(red("Issues"));
  for (const agent of withViolations) {
    console.log(`  ${agent.agent}`);
    for (const violation of agent.violations) {
      console.log(`    ${violation}`);
    }
  }
}

function shellDisplayQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function clear(): void {
  output.write("\x1Bc");
}

function bold(value: string): string {
  return `${styles.bold}${value}${styles.reset}`;
}

function dim(value: string): string {
  return `${styles.dim}${value}${styles.reset}`;
}

function muted(value: string): string {
  return `${styles.gray}${value}${styles.reset}`;
}

function cyan(value: string): string {
  return `${styles.cyan}${value}${styles.reset}`;
}

function green(value: string): string {
  return `${styles.green}${value}${styles.reset}`;
}

function yellow(value: string): string {
  return `${styles.yellow}${value}${styles.reset}`;
}

function red(value: string): string {
  return `${styles.red}${value}${styles.reset}`;
}
