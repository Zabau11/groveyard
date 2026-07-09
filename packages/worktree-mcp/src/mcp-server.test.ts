import assert from "node:assert/strict";
import test from "node:test";

import {
  agentContract,
  completionChecklist,
  createSessionNextSteps,
  instructionsResourceUri,
  renderAgentInstructions,
  recommendedWorkflow,
  sessionPolicy,
  workflowPromptName,
} from "./mcp-server.js";

test("agent contract explains the safe MCP workflow", () => {
  assert.ok(sessionPolicy.some((line) => line.includes("every code-changing task") && line.includes("create_session")));
  assert.ok(sessionPolicy.some((line) => line.includes("read-only")));
  assert.ok(agentContract.some((line) => line.includes("worktreePath")));
  assert.ok(agentContract.some((line) => line.includes("sessionId")));
  assert.ok(agentContract.some((line) => line.includes("git_status") && line.includes("git_diff")));
  assert.ok(agentContract.some((line) => line.includes("Commit only when the user asks")));
  assert.ok(agentContract.some((line) => line.includes("automatically retire clean sessions")));

  assert.equal(recommendedWorkflow[0], "create_session");
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
  });

  assert.ok(nextSteps.some((line) => line.includes("sess_test")));
  assert.ok(nextSteps.some((line) => line.includes("/tmp/groveyard/sess_test")));
  assert.ok(nextSteps.some((line) => line.includes("agent/test")));
  assert.ok(nextSteps.some((line) => line.includes("future code-changing tasks") && line.includes("fresh Groveyard session")));
  assert.ok(nextSteps.some((line) => line.includes("Do not manually commit or clean up") && line.includes("automatically retire sessions")));
});

test("agent instructions are available as MCP-native prompt and resource content", () => {
  const instructions = renderAgentInstructions("improve the website hero");

  assert.equal(instructionsResourceUri, "groveyard://instructions");
  assert.equal(workflowPromptName, "groveyard_session_workflow");
  assert.match(instructions, /# Groveyard Agent Instructions/);
  assert.match(instructions, /improve the website hero/);
  assert.match(instructions, /## Session Policy/);
  assert.match(instructions, /every code-changing task/);
  assert.match(instructions, /create_session/);
  assert.match(instructions, /git_status/);
  assert.match(instructions, /git_diff/);
});
