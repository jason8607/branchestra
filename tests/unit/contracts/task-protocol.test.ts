import { describe, expect, it } from "vitest";
import { RoomEventSchema } from "../../../src/shared/contracts/domain";
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

  it("rejects approval kinds paired with the wrong durable scope or round budget", () => {
    const event = {
      id: "22222222-2222-4222-8222-222222222222", roomId: "33333333-3333-4333-8333-333333333333", roomSeq: 1,
      type: "approval.requested", actor: "system", createdAt: "2026-07-21T00:00:00.000Z",
      payload: {
        request: {
          id: "request-1", taskId: "task-1", kind: "final_merge", scope: { operation: "push" },
          scopeHash: "sha256:scope", requestedGeneration: "generation-1", status: "pending",
          requestedAt: "2026-07-21T00:00:00.000Z"
        }
      }
    };
    expect(RoomEventSchema.safeParse(event).success).toBe(false);
    expect(RoomEventSchema.safeParse({
      ...event, payload: { request: { ...event.payload.request, kind: "additional_round", scope: { additionalRounds: 3 } } }
    }).success).toBe(false);
    expect(RoomEventSchema.safeParse({
      ...event, payload: { request: { ...event.payload.request, kind: "task_scope", scope: {
        repositoryRootRealpath: "/repo", gitCommonDirRealpath: "/repo/.git", writableRootsRealpath: ["/repo"],
        commandClasses: ["test"], allowCollaborator: false, toolNetwork: false, maxRunMs: 1000,
        collaborationRoundBudget: 3
      } } }
    }).success).toBe(false);
  });

  it("rejects malformed review checkpoint OIDs in task provider events", () => {
    const baseEvent = {
      id: "22222222-2222-4222-8222-222222222222", roomId: "33333333-3333-4333-8333-333333333333", roomSeq: 1,
      type: "agent.run", actor: "claude", createdAt: "2026-07-21T00:00:00.000Z",
      payload: { run: {
        id: "run-1", taskId: "task-1", provider: "claude", role: "reviewer", providerSessionId: null,
        contextVersion: 1, contextHash: "sha256:context", state: "completed",
        startedAt: "2026-07-21T00:00:00.000Z", finishedAt: "2026-07-21T00:00:01.000Z"
      }, event: { type: "review.findings", checkpointOid: "a".repeat(39), findings: ["rename"] } }
    };
    expect(RoomEventSchema.safeParse(baseEvent).success).toBe(false);
    expect(RoomEventSchema.safeParse({
      ...baseEvent, payload: { ...baseEvent.payload, event: { ...baseEvent.payload.event, checkpointOid: "g".repeat(40) } }
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
