import { describe, expect, it } from "vitest";
import { RendererRequestEnvelopeSchema } from "../../../src/shared/contracts/protocol";

const base = {
  v: 1,
  requestId: "11111111-1111-4111-8111-111111111111",
  idempotencyKey: "i1",
  workerGeneration: "00000000-0000-4000-8000-000000000004"
};

describe("task protocol", () => {
  it("accepts a typed final approval and rejects an incomplete tuple", () => {
    expect(RendererRequestEnvelopeSchema.safeParse({
      ...base, type: "task.approveFinalMerge", payload: {
        taskId: "task-1", approvalRequestId: "approval-request-1", targetRef: "refs/heads/main",
        baseOid: "a".repeat(40), candidateOid: "b".repeat(40),
        diffHash: "sha256:diff", testSetHash: "sha256:tests"
      }
    }).success).toBe(true);
    expect(RendererRequestEnvelopeSchema.safeParse({
      ...base, type: "task.approveFinalMerge", payload: {
        taskId: "task-1", approvalRequestId: "approval-request-1"
      }
    }).success).toBe(false);
  });

  it("rejects malformed task refs, OIDs, counts, and extra request fields", () => {
    for (const payload of [
      { taskId: "task-1", approvalRequestId: "request-1", targetRef: "main", baseOid: "a".repeat(40), candidateOid: "b".repeat(40), diffHash: "sha256:diff", testSetHash: "sha256:tests" },
      { taskId: "task-1", approvalRequestId: "request-1", targetRef: "refs/heads/main", baseOid: "a".repeat(39), candidateOid: "b".repeat(40), diffHash: "sha256:diff", testSetHash: "sha256:tests" }
    ]) {
      expect(RendererRequestEnvelopeSchema.safeParse({ ...base, type: "task.approveFinalMerge", payload }).success).toBe(false);
    }
    expect(RendererRequestEnvelopeSchema.safeParse({
      ...base, type: "task.grantAdditionalRound", payload: {
        taskId: "task-1", approvalRequestId: "request-1", additionalRounds: 3, displayedScopeHash: "sha256:scope"
      }
    }).success).toBe(false);
    expect(RendererRequestEnvelopeSchema.safeParse({
      ...base, type: "task.get", payload: { taskId: "task-1", extra: true }
    }).success).toBe(false);
  });
});
