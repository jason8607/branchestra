import type { TaskProviderRunRequest } from "../tasks/provider-port";
import type { MockProviderScript } from "./mock-provider";

export type E2EMockScenario = "two-round-success" | "interrupted-run";

export function e2eMockScript(
  scenario: E2EMockScenario,
  request: TaskProviderRunRequest
): MockProviderScript {
  if (scenario === "interrupted-run") {
    return {
      sessionId: `e2e-interrupted:${request.runId}`,
      steps: [
        { type: "workspace.writeText", relativePath: "partial.txt", contents: "keep after restart\n" },
        { type: "waitForCancel" }
      ]
    };
  }
  if (request.role === "lead") {
    return {
      sessionId: `e2e-lead:${request.runId}`,
      steps: [
        { type: "workspace.writeText", relativePath: "greeting.txt", contents: "hello from both agents\n" },
        { type: "test.request", commandId: "unit" },
        { type: "run.completed", summary: "Greeting implemented" }
      ]
    };
  }
  return {
    sessionId: `e2e-review:${request.runId}`,
    steps: [
      {
        type: "review.findings",
        checkpointOid: request.checkpointOid!,
        findings: request.instruction.includes('"round":2') ? [] : ["Confirm shared greeting"]
      },
      { type: "run.completed", summary: "Review complete" }
    ]
  };
}
