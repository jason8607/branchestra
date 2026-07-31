import { expect, it, vi } from "vitest";
import type { CommandHandler } from "../../../src/worker/protocol/command-handler";
import { createCommandContext } from "../../../src/worker/protocol/command-handler";
import { createTaskCommandHandlers } from "../../../src/worker/tasks/task-command-handlers";

it("rejects a stale generation and tuple before service mutation", async () => {
  const generation = "50000000-0000-4000-8000-000000000001";
  const finalApproval = { approve: vi.fn() };
  const handlers = createTaskCommandHandlers({
    workerGeneration: generation,
    taskService: {
      decideScope: vi.fn(),
      grantAdditionalRounds: vi.fn(),
      requestRevision: vi.fn()
    },
    taskEngine: { startApprovedTask: vi.fn(), cancel: vi.fn() },
    finalApproval,
    merge: { mergeApprovedCandidate: vi.fn() },
    recovery: { preview: vi.fn(), resolve: vi.fn() },
    inspector: { get: vi.fn() }
  });
  const handler = handlers.find(({ type }) => type === "task.approveFinalMerge") as
    CommandHandler<"task.approveFinalMerge">;

  await expect(handler.handle({
    type: "task.approveFinalMerge",
    payload: {
      taskId: "task-1",
      approvalRequestId: "approval-request-1",
      targetRef: "refs/heads/main",
      baseOid: "a".repeat(40),
      candidateOid: "b".repeat(40),
      diffHash: `sha256:${"c".repeat(64)}`,
      testSetHash: `sha256:${"d".repeat(64)}`
    }
  }, createCommandContext({
    requestId: "10000000-0000-4000-8000-000000000001",
    idempotencyKey: "approve-1",
    workerGeneration: "50000000-0000-4000-8000-000000000099"
  }))).rejects.toThrow("WORKER_GENERATION_MISMATCH");
  expect(finalApproval.approve).not.toHaveBeenCalled();
});
