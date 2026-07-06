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

server.tool(
  "server_info",
  "Return basic information about the Worktree MCP server.",
  {},
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            name: "worktree-mcp",
            version: "0.1.0",
            description: "Safe Git worktree sessions for coding agents.",
            status: "scaffolded",
          },
          null,
          2,
        ),
      },
    ],
  }),
);

server.tool(
  "create_session",
  "Create an isolated Git worktree session for a coding task. Use this before modifying files.",
  {
    repoPath: z.string().optional().describe("Path inside the Git repository. Defaults to the MCP server working directory."),
    taskName: z.string().min(1).describe("Short human-readable task name for the session."),
    baseBranch: z.string().min(1).optional().describe("Branch or ref to base the session on. Defaults to the current branch."),
  },
  async ({ repoPath, taskName, baseBranch }) => jsonResponse(await sessionService.createSession({ repoPath, taskName, baseBranch })),
);

server.tool(
  "list_sessions",
  "List registered worktree sessions for a repository.",
  {
    repoPath: z.string().optional().describe("Path inside the Git repository. Defaults to the MCP server working directory."),
  },
  async ({ repoPath }) => jsonResponse(await sessionService.listSessions(repoPath)),
);

server.tool(
  "get_session",
  "Return metadata for one registered worktree session.",
  {
    repoPath: z.string().optional().describe("Path inside the Git repository. Defaults to the MCP server working directory."),
    sessionId: z.string().min(1).describe("Session ID returned by create_session."),
  },
  async ({ repoPath, sessionId }) => jsonResponse(await sessionService.getSession({ repoPath, sessionId })),
);

server.tool(
  "cleanup_session",
  "Remove a registered session worktree and mark the session as cleaned.",
  {
    repoPath: z.string().optional().describe("Path inside the Git repository. Defaults to the MCP server working directory."),
    sessionId: z.string().min(1).describe("Session ID returned by create_session."),
  },
  async ({ repoPath, sessionId }) => jsonResponse(await sessionService.cleanupSession({ repoPath, sessionId })),
);

const transport = new StdioServerTransport();
await server.connect(transport);

function jsonResponse(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}
