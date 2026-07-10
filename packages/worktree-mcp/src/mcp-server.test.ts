import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  agentContract,
  completionChecklist,
  createMcpServer,
  createSessionNextSteps,
  instructionsResourceUri,
  renderAgentInstructions,
  recommendedWorkflow,
  sessionPolicy,
  workflowPromptName,
} from "./mcp-server.js";
import { getInstalledPackageVersion } from "./runtime-version.js";

test("agent contract explains the safe MCP workflow", () => {
  assert.ok(sessionPolicy.some((line) => line.includes("list_sessions")));
  assert.ok(sessionPolicy.some((line) => line.includes("resume_session")));
  assert.ok(sessionPolicy.some((line) => line.includes("read-only")));
  assert.ok(agentContract.some((line) => line.includes("worktreePath")));
  assert.ok(agentContract.some((line) => line.includes("sessionId")));
  assert.ok(agentContract.some((line) => line.includes("git_status") && line.includes("git_diff")));
  assert.ok(agentContract.some((line) => line.includes("Commit only when the user asks")));
  assert.ok(agentContract.some((line) => line.includes("automatically retire clean sessions")));

  assert.equal(recommendedWorkflow[0], "list_sessions");
  assert.equal(recommendedWorkflow[1], "resume_session or start_session");
  assert.ok(recommendedWorkflow.includes("run_command_profile when a relevant profile exists"));

  assert.ok(
    completionChecklist.some(
      (line) => line.includes("sessionId") && line.includes("branch") && line.includes("changed files") && line.includes("validation"),
    ),
  );
});

test("createSessionNextSteps binds guidance to the created session", () => {
  const nextSteps = createSessionNextSteps({
    id: "sess_test",
    branch: "agent/test",
    worktreePath: "/tmp/groveyard/sess_test",
    origin: "managed",
  });

  assert.ok(nextSteps.some((line) => line.includes("sess_test")));
  assert.ok(nextSteps.some((line) => line.includes("/tmp/groveyard/sess_test")));
  assert.ok(nextSteps.some((line) => line.includes("agent/test")));
  assert.ok(nextSteps.some((line) => line.includes("future code-changing tasks") && line.includes("list_sessions")));
  assert.ok(nextSteps.some((line) => line.includes("Do not manually commit or clean up") && line.includes("automatically retire sessions")));
});

test("agent instructions are available as MCP-native prompt and resource content", () => {
  const instructions = renderAgentInstructions("improve the website hero");

  assert.equal(instructionsResourceUri, "groveyard://instructions");
  assert.equal(workflowPromptName, "groveyard_session_workflow");
  assert.match(instructions, /# Groveyard Agent Instructions/);
  assert.match(instructions, /improve the website hero/);
  assert.match(instructions, /## Session Policy/);
  assert.match(instructions, /Before any code-changing task/);
  assert.match(instructions, /list_sessions/);
  assert.match(instructions, /resume_session/);
  assert.match(instructions, /git_status/);
  assert.match(instructions, /git_diff/);
});

test("MCP server metadata and server_info use the installed package version", async () => {
  const version = getInstalledPackageVersion();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: "groveyard-version-test", version: "1.0.0" }, { capabilities: {} });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const info = await client.callTool({ name: "server_info", arguments: {} });
  const content = (info as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  const payload = JSON.parse(content[0]?.type === "text" ? content[0].text ?? "{}" : "{}") as {
    data?: { version?: string };
  };
  const tools = await client.listTools();

  assert.equal(payload.data?.version, version);
  assert.ok(tools.tools.some((tool) => tool.name === "resume_session"));

  await clientTransport.close();
  await serverTransport.close();
});
