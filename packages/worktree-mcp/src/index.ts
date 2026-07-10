#!/usr/bin/env node

import { runCli } from "./cli.js";
import { startMcpServer } from "./mcp-server.js";
import { getInstalledPackageVersion } from "./runtime-version.js";

const cliCommands = new Set(["help", "--help", "-h", "--version", "-v", "setup", "init", "doctor", "connect", "dashboard", "sessions", "inspect", "commit", "clean", "upgrade"]);
const command = process.argv[2];

if (command === "--version" || command === "-v") {
  process.stdout.write(`${getInstalledPackageVersion()}\n`);
} else if (command && cliCommands.has(command)) {
  await runCli(process.argv.slice(2));
} else {
  await startMcpServer();
}
