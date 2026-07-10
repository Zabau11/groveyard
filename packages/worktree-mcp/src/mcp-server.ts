import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { WorktreeSessionService } from "./lifecycle.js";
import type { SessionRecord } from "./sessions.js";

export const mcpServerVersion = "0.1.15";
export const instructionsResourceUri = "groveyard://instructions";
export const workflowPromptName = "groveyard_session_workflow";

export const sessionPolicy = [
  "For every code-changing task, first call start_session and pass the current workspace directory so Groveyard can create or adopt the right workspace.",
  "Do not create a session for read-only questions, explanations, planning, status checks, or reviews that will not modify files.",
];

export const agentContract = [
  ...sessionPolicy,
  "For managed sessions, work only inside the returned worktreePath. For adopted sessions, continue in the existing workspace; Groveyard tracks but never removes it.",
  "Use the sessionId returned by start_session for every session-scoped Groveyard tool call.",
  "Read files or list directories before writing. Do not guess file contents.",
  "Write only paths relative to the session worktree. Absolute paths and path escapes are rejected.",
  "Run configured command profiles with run_command_profile when validation is needed. Groveyard command profiles are the approved command surface.",
  "Before reporting completion, call git_status and git_diff for the session and summarize the changed files.",
  "Commit only when the user asks you to commit. Groveyard may automatically retire clean sessions when Git proves the branch is completed or merged into a configured target branch.",
];

export const recommendedWorkflow = [
  "start_session",
  "list_files or read_file",
  "write_file",
  "run_command_profile when a relevant profile exists",
  "git_status",
  "git_diff",
  "contract_status",
  "commit_session only on request",
  "cleanup_session only on request or automatic Git-state reconciliation",
];

export const completionChecklist = [
  "All edits stayed inside the session worktree.",
  "Relevant command profiles were run or skipped with a clear reason.",
  "git_status was checked.",
  "git_diff was checked.",
  "The final response names the sessionId, branch, changed files, and validation result.",
];

export function renderAgentInstructions(taskName = "the user's task"): string {
  return [
    "# Groveyard Agent Instructions",
    "",
    `Use Groveyard to isolate ${taskName} in a registered Git worktree session whenever the task may change code.`,
    "",
    "## Session Policy",
    ...sessionPolicy.map((line) => `- ${line}`),
    "",
    "## Contract",
    ...agentContract.map((line) => `- ${line}`),
    "",
    "## Recommended Workflow",
    ...recommendedWorkflow.map((step, index) => `${index + 1}. ${step}`),
    "",
    "## Completion Checklist",
    ...completionChecklist.map((line) => `- ${line}`),
  ].join("\n");
}

export function createMcpServer(): McpServer {
  const sessionService = new WorktreeSessionService();

  const server = new McpServer({
    name: "groveyard",
    version: mcpServerVersion,
  });

  const repoPathDescription =
    "Path inside the Git repository to manage, resolved on the MCP server process filesystem. Defaults to GROVEYARD_REPO, then the MCP server working directory. For remote or sandboxed MCP clients, this path must be visible to the Groveyard server host.";
  const sessionIdDescription = "Session ID returned by start_session. All operations are scoped to this registered worktree session.";

  server.registerResource(
    "groveyard_instructions",
    instructionsResourceUri,
    {
      title: "Groveyard Agent Instructions",
      description: "The safe worktree workflow coding agents should follow when using Groveyard.",
      mimeType: "text/markdown",
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: renderAgentInstructions(),
        },
      ],
    }),
  );

  server.registerPrompt(
    workflowPromptName,
    {
      title: "Groveyard Session Workflow",
      description: "Start a coding task in an isolated Groveyard worktree and finish with status and diff review.",
      argsSchema: {
        taskName: z.string().optional().describe("Short description of the coding task."),
      },
    },
    ({ taskName }) => ({
      description: "Instructions for a coding agent using Groveyard.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: renderAgentInstructions(taskName),
          },
        },
      ],
    }),
  );

  server.tool(
    "server_info",
    "Return basic information and the recommended agent workflow for Groveyard.",
    {},
    async () =>
      jsonResponse("server_info", {
        name: "groveyard",
        version: mcpServerVersion,
        description: "Safe Git worktree sessions for coding agents.",
        status: "mvp",
        instructionsResourceUri,
        workflowPromptName,
        workflow: recommendedWorkflow,
        agentContract,
        completionChecklist,
        sessionPolicy,
      }),
  );

  server.tool(
    "start_session",
    "Start a Groveyard session for a coding task. Pass the current workspace directory so Groveyard adopts an existing linked worktree when appropriate; otherwise it creates a managed worktree. Adopted worktrees are tracked but never removed by Groveyard.",
    {
      repoPath: z.string().optional().describe(repoPathDescription),
      taskName: z.string().min(1).describe("Short human-readable task description."),
      workspacePath: z.string().optional().describe("Current coding workspace directory. Paths inside linked worktrees resolve to the worktree root."),
      baseBranch: z.string().min(1).optional().describe("Optional base ref for managed sessions; metadata only for adopted sessions."),
    },
    async ({ repoPath, taskName, workspacePath, baseBranch }) => {
      const result = await sessionService.startSession({ repoPath, taskName, workspacePath, baseBranch });
      const session = result.session;
      return jsonResponse("start_session", {
        ...result,
        sessionId: session.id,
        workspacePath: session.worktreePath,
        branch: session.branch,
        mode: session.origin,
        nextAction: session.origin === "managed"
          ? `Perform all task work in ${session.worktreePath}.`
          : `Continue task work in the existing workspace ${session.worktreePath}; Groveyard will not remove it.`,
      }, createSessionNextSteps(session), {
        agentContract,
        completionChecklist,
        instructionsResourceUri,
        workflowPromptName,
      });
    },
  );

  server.tool(
    "create_session",
    "Compatibility alias for callers that require a newly managed worktree. New integrations should use start_session.",
    {
      repoPath: z.string().optional().describe(repoPathDescription),
      taskName: z.string().min(1).describe("Short human-readable task name for the session."),
      baseBranch: z.string().min(1).optional().describe("Branch or ref to base the session on. Defaults to the current branch."),
    },
    async ({ repoPath, taskName, baseBranch }) => {
      const session = await sessionService.createSession({ repoPath, taskName, baseBranch });
      return jsonResponse("create_session", session, createSessionNextSteps(session), {
        agentContract,
        completionChecklist,
        instructionsResourceUri,
        workflowPromptName,
      });
    },
  );

  server.tool(
    "session_status",
    "Return a session's metadata and current Git status.",
    {
      repoPath: z.string().optional().describe(repoPathDescription),
      sessionId: z.string().min(1).describe(sessionIdDescription),
    },
    async ({ repoPath, sessionId }) => jsonResponse("session_status", await sessionService.gitStatus({ repoPath, sessionId })),
  );

  server.tool(
    "validate_session",
    "Review Git status, diff, and the Groveyard completion contract for an active session.",
    {
      repoPath: z.string().optional().describe(repoPathDescription),
      sessionId: z.string().min(1).describe(sessionIdDescription),
    },
    async ({ repoPath, sessionId }) => {
      const status = await sessionService.gitStatus({ repoPath, sessionId });
      const diff = await sessionService.gitDiff({ repoPath, sessionId });
      const contract = await sessionService.contractStatus({ repoPath, sessionId });
      return jsonResponse("validate_session", { session: contract.session, status: status.status, diff: diff.diff, contract });
    },
  );

  server.tool(
    "finish_session",
    "Validate an active session and return its handoff state. This does not remove the workspace or commit changes.",
    {
      repoPath: z.string().optional().describe(repoPathDescription),
      sessionId: z.string().min(1).describe(sessionIdDescription),
    },
    async ({ repoPath, sessionId }) => {
      const status = await sessionService.gitStatus({ repoPath, sessionId });
      const diff = await sessionService.gitDiff({ repoPath, sessionId });
      const contract = await sessionService.contractStatus({ repoPath, sessionId });
      return jsonResponse("finish_session", { session: contract.session, status: status.status, diff: diff.diff, ready: contract.readyToCommit });
    },
  );

  server.tool(
    "list_sessions",
    "List registered worktree sessions for a repository. Use this to find active sessions before creating duplicates.",
    {
      repoPath: z.string().optional().describe(repoPathDescription),
    },
    async ({ repoPath }) => jsonResponse("list_sessions", await sessionService.listSessions(repoPath)),
  );

  server.tool(
    "get_session",
    "Return metadata for one registered worktree session, including its branch and isolated worktree path.",
    {
      repoPath: z.string().optional().describe(repoPathDescription),
      sessionId: z.string().min(1).describe(sessionIdDescription),
    },
    async ({ repoPath, sessionId }) => jsonResponse("get_session", await sessionService.getSession({ repoPath, sessionId })),
  );

  server.tool(
    "cleanup_session",
    "Remove a registered session worktree and mark it as cleaned. Use this only after the user no longer needs the session files.",
    {
      repoPath: z.string().optional().describe(repoPathDescription),
      sessionId: z.string().min(1).describe(sessionIdDescription),
    },
    async ({ repoPath, sessionId }) =>
      jsonResponse("cleanup_session", await sessionService.cleanupSession({ repoPath, sessionId }), [
        "Do not continue file, command, status, or diff operations against a cleaned session.",
      ]),
  );

  server.tool(
    "git_status",
    "Return git status --short for a registered worktree session. Use this to summarize changed files before completion.",
    {
      repoPath: z.string().optional().describe(repoPathDescription),
      sessionId: z.string().min(1).describe(sessionIdDescription),
    },
    async ({ repoPath, sessionId }) =>
      jsonResponse("git_status", await sessionService.gitStatus({ repoPath, sessionId }), ["Call git_diff next to inspect the patch content."]),
  );

  server.tool(
    "git_diff",
    "Return the current patch for a registered worktree session. Call this before reporting completion or asking the user to review.",
    {
      repoPath: z.string().optional().describe(repoPathDescription),
      sessionId: z.string().min(1).describe(sessionIdDescription),
    },
    async ({ repoPath, sessionId }) => jsonResponse("git_diff", await sessionService.gitDiff({ repoPath, sessionId })),
  );

  server.tool(
    "contract_status",
    "Return Groveyard's enforced contract status for a registered session, including whether status and diff were reviewed after the latest mutation.",
    {
      repoPath: z.string().optional().describe(repoPathDescription),
      sessionId: z.string().min(1).describe(sessionIdDescription),
    },
    async ({ repoPath, sessionId }) =>
      jsonResponse("contract_status", await sessionService.contractStatus({ repoPath, sessionId }), [
        "Complete every requiredAction before committing or reporting the task as ready.",
      ]),
  );

  server.tool(
    "read_file",
    "Read a UTF-8 text file inside a registered worktree session. Paths are relative and cannot escape the session worktree.",
    {
      repoPath: z.string().optional().describe(repoPathDescription),
      sessionId: z.string().min(1).describe(sessionIdDescription),
      path: z.string().min(1).describe("Relative file path inside the session worktree. Absolute paths and .. escapes are rejected."),
    },
    async ({ repoPath, sessionId, path }) => jsonResponse("read_file", await sessionService.readFile({ repoPath, sessionId, path })),
  );

  server.tool(
    "write_file",
    "Write a UTF-8 text file inside a registered worktree session. Read existing files first when modifying code. Never write outside the session worktree.",
    {
      repoPath: z.string().optional().describe(repoPathDescription),
      sessionId: z.string().min(1).describe(sessionIdDescription),
      path: z.string().min(1).describe("Relative file path inside the session worktree. Absolute paths, .. escapes, and unsafe symlinks are rejected."),
      content: z.string().describe("UTF-8 text content to write."),
    },
    async ({ repoPath, sessionId, path, content }) =>
      jsonResponse("write_file", await sessionService.writeFile({ repoPath, sessionId, path, content }), [
        "Run an appropriate command profile if one is configured.",
        "Call git_status and git_diff after edits.",
      ]),
  );

  server.tool(
    "list_files",
    "List regular files under a relative directory inside a registered worktree session. Symlinks and .git internals are skipped.",
    {
      repoPath: z.string().optional().describe(repoPathDescription),
      sessionId: z.string().min(1).describe(sessionIdDescription),
      path: z.string().min(1).default(".").describe("Relative directory path inside the session worktree. Use . for the worktree root."),
    },
    async ({ repoPath, sessionId, path }) => jsonResponse("list_files", await sessionService.listFiles({ repoPath, sessionId, path })),
  );

  server.tool(
    "run_command_profile",
    "Run a named command profile from .groveyard.yml inside a registered worktree session. This tool does not accept arbitrary shell commands.",
    {
      repoPath: z.string().optional().describe(repoPathDescription),
      sessionId: z.string().min(1).describe(sessionIdDescription),
      profile: z.string().min(1).describe("Command profile name from .groveyard.yml, such as test, lint, or build."),
    },
    async ({ repoPath, sessionId, profile }) =>
      jsonResponse("run_command_profile", await sessionService.runCommandProfile({ repoPath, sessionId, profile }), [
        "Inspect exitCode, stdout, and stderr before deciding whether the task is complete.",
        "Call git_status and git_diff after successful edits.",
      ]),
  );

  server.tool(
    "commit_session",
    "Stage all changes in a registered worktree session and create a Git commit on the session branch. Use this only when the user asks for a commit.",
    {
      repoPath: z.string().optional().describe(repoPathDescription),
      sessionId: z.string().min(1).describe(sessionIdDescription),
      message: z.string().min(1).describe("Commit message to use for the session changes."),
    },
    async ({ repoPath, sessionId, message }) =>
      jsonResponse("commit_session", await sessionService.commitSession({ repoPath, sessionId, message }), [
        "Use the returned commit SHA and branch for review, push, or PR workflows.",
        "Call cleanup_session only after the user no longer needs the worktree.",
      ]),
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export function createSessionNextSteps(session: Pick<SessionRecord, "id" | "branch" | "worktreePath" | "origin">): string[] {
  return [
    `Use sessionId ${session.id} for every Groveyard tool call in this task.`,
    session.origin === "managed"
      ? `Work only inside the newly managed workspace ${session.worktreePath}.`
      : `Continue in the adopted workspace ${session.worktreePath}; Groveyard will track but never remove it.`,
    `Keep changes on branch ${session.branch}.`,
    "Start by listing or reading the files relevant to the task.",
    "For future code-changing tasks, call start_session before implementation work begins.",
    "Call read_file before overwriting any existing file.",
    "After edits, run a relevant command profile if one exists.",
    "Before your final answer, call git_status and git_diff for this session.",
    "Call contract_status to confirm the enforced checklist is clear.",
    "Do not manually commit or clean up this session unless the user explicitly asks; Groveyard may automatically retire sessions when Git proves they are done.",
  ];
}

type ResponseGuidance = {
  agentContract?: string[];
  completionChecklist?: string[];
  instructionsResourceUri?: string;
  workflowPromptName?: string;
};

function jsonResponse(tool: string, data: unknown, nextSteps: string[] = [], guidance: ResponseGuidance = {}) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            ok: true,
            tool,
            data,
            guidance,
            nextSteps,
          },
          null,
          2,
        ),
      },
    ],
  };
}
