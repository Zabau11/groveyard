#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { WorktreeSessionService } from "./lifecycle.js";

const sessionService = new WorktreeSessionService();

const server = new McpServer({
  name: "worktree-mcp",
  version: "0.1.0",
});

const repoPathDescription = "Path inside the Git repository to manage. Defaults to the MCP server working directory.";
const sessionIdDescription = "Session ID returned by create_session. All operations are scoped to this registered worktree session.";

server.tool(
  "server_info",
  "Return basic information and the recommended agent workflow for Worktree MCP.",
  {},
  async () =>
    jsonResponse("server_info", {
      name: "worktree-mcp",
      version: "0.1.0",
      description: "Safe Git worktree sessions for coding agents.",
      status: "mvp",
      workflow: ["create_session", "read_file/list_files", "write_file", "run_command_profile", "git_status", "git_diff"],
    }),
);

server.tool(
  "create_session",
  "Create an isolated Git worktree session for a coding task. Call this before reading, writing, running commands, or reporting code changes.",
  {
    repoPath: z.string().optional().describe(repoPathDescription),
    taskName: z.string().min(1).describe("Short human-readable task name for the session."),
    baseBranch: z.string().min(1).optional().describe("Branch or ref to base the session on. Defaults to the current branch."),
  },
  async ({ repoPath, taskName, baseBranch }) =>
    jsonResponse("create_session", await sessionService.createSession({ repoPath, taskName, baseBranch }), [
      "Use this sessionId for all file, command, status, diff, and cleanup tools.",
      "Read or list files before editing.",
      "Call git_status and git_diff before reporting completion.",
    ]),
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
  "Write a UTF-8 text file inside a registered worktree session. Read existing files first when modifying code.",
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
  "Run a named command profile from .worktree-mcp.yml inside a registered worktree session. This tool does not accept arbitrary shell commands.",
  {
    repoPath: z.string().optional().describe(repoPathDescription),
    sessionId: z.string().min(1).describe(sessionIdDescription),
    profile: z.string().min(1).describe("Command profile name from .worktree-mcp.yml, such as test, lint, or build."),
  },
  async ({ repoPath, sessionId, profile }) =>
    jsonResponse("run_command_profile", await sessionService.runCommandProfile({ repoPath, sessionId, profile }), [
      "Inspect exitCode, stdout, and stderr before deciding whether the task is complete.",
      "Call git_status and git_diff after successful edits.",
    ]),
);

const transport = new StdioServerTransport();
await server.connect(transport);

function jsonResponse(tool: string, data: unknown, nextSteps: string[] = []) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            ok: true,
            tool,
            data,
            nextSteps,
          },
          null,
          2,
        ),
      },
    ],
  };
}
