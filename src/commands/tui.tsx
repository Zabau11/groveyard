import React, { useEffect, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import { readFile } from "node:fs/promises";
import { composeRun } from "./compose.js";
import { runDoctor, type DoctorReport } from "./doctor.js";
import { createDraftPlan, previewDraftPlan, type DraftPlanPreview } from "./plan.js";
import { generateReport } from "./report.js";
import { runPlanFile, type RunProgressEvent } from "./run.js";
import { listRunStatuses, type RunStatusListItem } from "./status.js";
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

type Screen = "home" | "loading" | "plan" | "runs" | "doctor" | "help" | "running" | "done" | "error";
type FlowMode = "new" | "explain";

type HomeModel = {
  doctorStatus: string;
  runCount: number;
  latestRun?: string;
  planner: string;
};

type RunResult = {
  runId: string;
  runStatus: string;
  composeStatus?: string;
  verifyStatus?: string;
  reportPath?: string;
};

export async function launchTui(options: TuiOptions): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("AgentX Console needs an interactive terminal.");
    console.log("Run agentx --help to use the scriptable CLI.");
    return;
  }

  const instance = render(<AgentXApp cwd={options.cwd} />);
  await instance.waitUntilExit();
}

function AgentXApp({ cwd }: { cwd: string }): React.ReactElement {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>("home");
  const [command, setCommand] = useState("");
  const [mode, setMode] = useState<FlowMode>("new");
  const [goal, setGoal] = useState("");
  const [home, setHome] = useState<HomeModel>({ doctorStatus: "loading", runCount: 0, planner: "local" });
  const [preview, setPreview] = useState<DraftPlanPreview | undefined>();
  const [runs, setRuns] = useState<RunStatusListItem[]>([]);
  const [doctor, setDoctor] = useState<DoctorReport | undefined>();
  const [runLog, setRunLog] = useState<string[]>([]);
  const [runResult, setRunResult] = useState<RunResult | undefined>();
  const [message, setMessage] = useState("");

  useEffect(() => {
    void loadHomeModel(cwd).then(setHome);
  }, [cwd]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }

    if (screen === "home") {
      if (key.return) {
        void handleCommand(command);
        return;
      }
      if (key.backspace || key.delete) {
        setCommand((value) => value.slice(0, -1));
        return;
      }
      if (key.escape) {
        exit();
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setCommand((value) => `${value}${input}`);
      }
      return;
    }

    if (screen === "plan") {
      if (key.escape) {
        resetHome();
        return;
      }
      if (input === "q") {
        exit();
        return;
      }
      if (mode === "new" && (key.return || input === "r")) {
        void runCurrentGoal();
        return;
      }
      if (mode === "explain" && (key.return || input === "b")) {
        resetHome();
      }
      return;
    }

    if (screen === "runs" || screen === "doctor" || screen === "help" || screen === "done" || screen === "error") {
      if (input === "q") {
        exit();
        return;
      }
      if (key.return || key.escape || input === "b") {
        resetHome();
      }
    }
  });

  async function handleCommand(raw: string): Promise<void> {
    const intent = parseConsoleIntent(raw);
    setCommand("");
    switch (intent.type) {
      case "new":
        await startPreview(intent.goal ?? "", "new");
        return;
      case "explain":
        await startPreview(intent.goal ?? "", "explain");
        return;
      case "runs":
        setScreen("loading");
        setMessage("Loading run history");
        setRuns(await listRunStatuses(cwd));
        setScreen("runs");
        return;
      case "doctor":
        setScreen("loading");
        setMessage("Checking repository");
        setDoctor(await runDoctor(cwd));
        setScreen("doctor");
        return;
      case "help":
        setScreen("help");
        return;
      case "exit":
        exit();
        return;
    }
  }

  async function startPreview(nextGoal: string, nextMode: FlowMode): Promise<void> {
    const trimmedGoal = nextGoal.trim();
    if (!trimmedGoal) {
      setScreen("error");
      setMessage("Type a task, or use explain <task>.");
      return;
    }

    setMode(nextMode);
    setGoal(trimmedGoal);
    setScreen("loading");
    setMessage("Reading repo shape and selecting lanes");
    try {
      const draft = await previewDraftPlan(trimmedGoal, cwd, { adapter: "auto", planner: "auto" });
      setPreview(draft);
      setScreen("plan");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setScreen("error");
    }
  }

  async function runCurrentGoal(): Promise<void> {
    setScreen("running");
    setRunLog(["Creating task plan"]);
    setRunResult(undefined);
    try {
      const plan = await createDraftPlan(goal, cwd, { adapter: "auto", planner: "auto" });
      appendRunLog(`Plan ready: ${plan.runId}`);
      const run = await runPlanFile(plan.path, cwd, { onProgress: (event) => appendProgress(event) });
      appendRunLog(`Run ${run.status}`);
      const composition = await composeRun(run.runId, cwd);
      appendRunLog(`Compose ${composition.status}`);
      const verification = await verifyRun(run.runId, cwd);
      appendRunLog(`Verify ${verification.status}`);
      const report = await generateReport(run.runId, cwd);
      setRunResult({
        runId: run.runId,
        runStatus: run.status,
        composeStatus: composition.status,
        verifyStatus: verification.status,
        reportPath: report.reportPath,
      });
      setScreen("done");
      void loadHomeModel(cwd).then(setHome);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setScreen("error");
    }
  }

  function appendRunLog(line: string): void {
    setRunLog((lines) => [...lines.slice(-8), line]);
  }

  function appendProgress(event: RunProgressEvent): void {
    switch (event.type) {
      case "run_started":
        appendRunLog(`Running ${event.agentCount} agent${event.agentCount === 1 ? "" : "s"}`);
        return;
      case "agent_started":
        appendRunLog(`${event.agent} started: ${event.owns.join(", ")}`);
        return;
      case "agent_activity":
        appendRunLog(event.activity);
        return;
      case "agent_finished":
        appendRunLog(`${event.agent} ${event.status}: ${event.changedFiles} changed, ${event.violations} violations`);
        return;
      case "run_finished":
      case "agent_command":
      case "agent_output":
        return;
    }
  }

  function resetHome(): void {
    setScreen("home");
    setMessage("");
    setPreview(undefined);
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header />
      {screen === "home" && <HomeScreen home={home} command={command} />}
      {screen === "loading" && <LoadingScreen message={message} />}
      {screen === "plan" && preview && <PlanScreen preview={preview} mode={mode} />}
      {screen === "runs" && <RunsScreen runs={runs} />}
      {screen === "doctor" && doctor && <DoctorScreen report={doctor} />}
      {screen === "help" && <HelpScreen />}
      {screen === "running" && <RunningScreen goal={goal} lines={runLog} />}
      {screen === "done" && runResult && <DoneScreen result={runResult} />}
      {screen === "error" && <ErrorScreen message={message} />}
    </Box>
  );
}

function Header(): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="blue">━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</Text>
      <Box>
        <Text inverse bold>
          {" AGENTX "}
        </Text>
        <Text color="gray"> Task-native orchestration for coding agents</Text>
      </Box>
      <Text color="blue">━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</Text>
    </Box>
  );
}

function HomeScreen({ home, command }: { home: HomeModel; command: string }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box gap={4}>
        <Panel title="Command Center" width={54}>
          <Text color="gray">Type a task directly. AgentX handles the workflow.</Text>
          <Box height={1} />
          <CommandExample label="RUN" value="add retry support for failed agents" />
          <CommandExample label="EXPLAIN" value="explain add retry support for failed agents" />
          <Box height={1} />
          <ActionRow command="new" detail="guided task launch" />
          <ActionRow command="runs" detail="recent orchestration history" />
          <ActionRow command="doctor" detail="repository readiness" />
          <ActionRow command="quit" detail="leave the console" />
        </Panel>
        <Panel title="Workspace" width={34}>
          <StatusRow status={home.doctorStatus} detail="doctor" />
          <StatusRow status={home.planner === "mistral" ? "llm" : "local"} detail={`planner ${home.planner}`} />
          <StatusRow status={home.runCount > 0 ? "info" : "ready"} detail={`${home.runCount} saved run${home.runCount === 1 ? "" : "s"}`} />
          <Box height={1} />
          <Text bold>Flow</Text>
          <Step index="1" label="plan lanes" />
          <Step index="2" label="run adapters" />
          <Step index="3" label="compose changes" />
          <Step index="4" label="verify result" />
          <Box height={1} />
          <Text color="gray">{home.latestRun ? `latest ${truncate(home.latestRun, 30)}` : "latest no saved runs yet"}</Text>
        </Panel>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">Use </Text>
        <Text color="cyan">help</Text>
        <Text color="gray"> for examples, or type the change you want below.</Text>
      </Box>
      <CommandBar value={command} />
    </Box>
  );
}

function LoadingScreen({ message }: { message: string }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color="cyan">● {message}</Text>
      <Text color="gray">AgentX is working through the repository state.</Text>
    </Box>
  );
}

function PlanScreen({ preview, mode }: { preview: DraftPlanPreview; mode: FlowMode }): React.ReactElement {
  const agents = Object.entries(preview.plan.agents);
  return (
    <Box flexDirection="column">
      <Panel title="Plan Preview">
        <Text color="gray">Task: {preview.goal}</Text>
        <Text color="gray">
          {agents.length} agent{agents.length === 1 ? "" : "s"} selected by {plannerLabel(preview)}
        </Text>
      </Panel>
      <Box marginTop={1} flexDirection="column">
        <Text bold color="blue">
          Execution lanes
        </Text>
        {agents.map(([agentName, agent]) => (
          <Box key={agentName} flexDirection="column" marginTop={1}>
            <Text>
              <Text color="blue" bold>
                [{agentName}]
              </Text>{" "}
              <Text color="gray">owns</Text> {agent.owns.join(", ")}
            </Text>
            <Text color="gray">  reason   {preview.planner.reason && agents.length === 1 ? preview.planner.reason : `This lane owns ${agent.owns.join(", ")}.`}</Text>
            {agent.forbidden.length > 0 && <Text color="gray">  protects {agent.forbidden.slice(0, 5).join(", ")}{agent.forbidden.length > 5 ? ", ..." : ""}</Text>}
          </Box>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold color="blue">
          Verification
        </Text>
        {preview.plan.verify.length > 0 ? preview.plan.verify.map((command) => <Text key={command}>  $ {command}</Text>) : <Text color="gray">  none detected</Text>}
      </Box>
      <Footer hint={mode === "new" ? "Enter/r run · Esc back · q quit" : "Enter back · q quit"} />
    </Box>
  );
}

function RunsScreen({ runs }: { runs: RunStatusListItem[] }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Panel title="Runs">
        {runs.length === 0 ? (
          <Text color="gray">No saved AgentX runs yet.</Text>
        ) : (
          runs.slice(-10).map((run) => (
            <Box key={run.runId} flexDirection="column" marginBottom={1}>
              <Text>
                <StatusPill status={run.status} /> <Text bold>{truncate(run.runId, 56)}</Text>
              </Text>
              <Text color="gray">
                agents {run.agents} · accepted {run.accepted} · verify {run.verified} · {run.composed ? "composed" : "not composed"}
              </Text>
            </Box>
          ))
        )}
      </Panel>
      <Footer hint="Enter back · q quit" />
    </Box>
  );
}

function DoctorScreen({ report }: { report: DoctorReport }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Panel title="Doctor">
        <StatusRow status={report.status} detail="repository readiness" />
      </Panel>
      {report.sections.map((section) => (
        <Box key={section.title} flexDirection="column" marginTop={1}>
          <Text bold color="blue">
            {section.title}
          </Text>
          {section.checks.map((check) => (
            <Box key={`${section.title}-${check.label}`} flexDirection="column">
              <Text>
                <StatusPill status={check.status} /> <Text bold>{check.label}</Text> <Text color="gray">{check.detail}</Text>
              </Text>
              {check.fix && <Text color="gray">  fix: {check.fix}</Text>}
            </Box>
          ))}
        </Box>
      ))}
      <Footer hint="Enter back · q quit" />
    </Box>
  );
}

function HelpScreen(): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Panel title="How to talk to AgentX">
        <Text color="gray">Type a task directly to plan and run it.</Text>
        <Text color="gray">Prefix with explain when you only want a preview.</Text>
      </Panel>
      <Box marginTop={1} flexDirection="column">
        <CommandExample label="RUN" value="add retry support for failed agents" />
        <CommandExample label="EXPLAIN" value="explain add retry support for failed agents" />
        <CommandExample label="ACTION" value="runs" />
        <CommandExample label="ACTION" value="doctor" />
      </Box>
      <Footer hint="Enter back · q quit" />
    </Box>
  );
}

function RunningScreen({ goal, lines }: { goal: string; lines: string[] }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Panel title="Running">
        <Text color="gray">{goal}</Text>
      </Panel>
      <Box marginTop={1} flexDirection="column">
        {lines.map((line, index) => (
          <Text key={`${index}-${line}`}>
            <Text color="cyan">●</Text> {line}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function DoneScreen({ result }: { result: RunResult }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Panel title="Run Complete">
        <StatusRow status={result.runStatus} detail="agents finished" />
        {result.composeStatus && <StatusRow status={result.composeStatus} detail="composition" />}
        {result.verifyStatus && <StatusRow status={result.verifyStatus} detail="verification" />}
        {result.reportPath && <Text color="gray">Report: {result.reportPath}</Text>}
      </Panel>
      <Box marginTop={1} flexDirection="column">
        <Text bold color="blue">
          Next
        </Text>
        <Text>
          <Text color="cyan">agentx apply --run {result.runId}</Text> <Text color="gray">bring changes back</Text>
        </Text>
        <Text>
          <Text color="cyan">agentx status --run {result.runId}</Text> <Text color="gray">inspect result</Text>
        </Text>
      </Box>
      <Footer hint="Enter home · q quit" />
    </Box>
  );
}

function ErrorScreen({ message }: { message: string }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Panel title="Needs Attention">
        <Text color="red">{message}</Text>
      </Panel>
      <Footer hint="Enter back · q quit" />
    </Box>
  );
}

function Panel({ title, width, children }: { title: string; width?: number; children: React.ReactNode }): React.ReactElement {
  return (
    <Box flexDirection="column" width={width} borderStyle="round" borderColor="blue" paddingX={1} paddingY={0}>
      <Text bold>{title}</Text>
      {children}
    </Box>
  );
}

function CommandExample({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <Text>
      <Text inverse bold>
        {" "}
        {label}
        {" "}
      </Text>{" "}
      {value}
    </Text>
  );
}

function ActionRow({ command, detail }: { command: string; detail: string }): React.ReactElement {
  return (
    <Text>
      <Text color="cyan">{command.padEnd(8)}</Text>
      <Text color="gray">{detail}</Text>
    </Text>
  );
}

function Step({ index, label }: { index: string; label: string }): React.ReactElement {
  return (
    <Text>
      <Text color="blue" bold>
        {index}
      </Text>{" "}
      {label}
    </Text>
  );
}

function StatusRow({ status, detail }: { status: string; detail: string }): React.ReactElement {
  return (
    <Text>
      <StatusPill status={status} /> <Text color="gray">{detail}</Text>
    </Text>
  );
}

function StatusPill({ status }: { status: string }): React.ReactElement {
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
      ? "green"
      : normalized === "warn" || normalized === "needs_attention" || normalized.includes("skip") || normalized.includes("rejection")
        ? "yellow"
        : normalized === "info" || normalized === "done" || normalized === "local"
          ? "blue"
          : "red";

  return (
    <Text color={color} bold>
      [{label}]
    </Text>
  );
}

function CommandBar({ value }: { value: string }): React.ReactElement {
  return (
    <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Box>
        <Text inverse bold>
          {" AGENTX "}
        </Text>
        <Text color="gray"> What should AgentX do?</Text>
      </Box>
      <Box>
        <Text color="cyan">&gt; </Text>
        <Text>{value}</Text>
        <Text color="gray">█</Text>
      </Box>
    </Box>
  );
}

function Footer({ hint }: { hint: string }): React.ReactElement {
  return (
    <Box marginTop={1}>
      <Text color="gray">{hint}</Text>
    </Box>
  );
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

function plannerLabel(preview: DraftPlanPreview): string {
  const confidence = typeof preview.planner.confidence === "number" ? `, ${Math.round(preview.planner.confidence * 100)}% confidence` : "";
  return `${preview.planner.source}${confidence}`;
}

function truncate(value: string, length: number): string {
  if (value.length <= length) {
    return value;
  }
  return `${value.slice(0, Math.max(0, length - 3))}...`;
}
