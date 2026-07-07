#!/usr/bin/env node

import { runCli } from "./cli.js";
import { startMcpServer } from "./mcp-server.js";

const cliCommands = new Set(["help", "--help", "-h", "init", "doctor", "sessions", "inspect", "clean"]);
const command = process.argv[2];

if (command && cliCommands.has(command)) {
  await runCli(process.argv.slice(2));
} else {
  await startMcpServer();
}
