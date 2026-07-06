#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

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

const transport = new StdioServerTransport();
await server.connect(transport);
