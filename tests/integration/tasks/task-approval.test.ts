import { describe, expect, it } from "vitest";
import { createApprovedTaskFixture } from "../../fixtures/task-engine";
import { hashCanonical } from "../../../src/worker/approvals/canonical-json";
import { transitionTask } from "../../../src/worker/tasks/task-state-machine";

describe("mention-driven task approval", () => {
  it("creates AwaitingApproval from a user mention without mutating Git", async () => {
    const fixture = await createApprovedTaskFixture();
    try {
      const before = await fixture.captureGitState();
      const result = await fixture.service.createFromUserMessage({
        roomId: fixture.room.id,
        messageEventId: "event-1",
        text: "@Claude implement parser",
        explicitLead: null,
        idempotencyKey: "message-1"
      });
      expect(result.task.state).toBe("AwaitingApproval");
      expect(result.task.leadProvider).toBe("claude");
      expect(result.approvalRequest.scope).toMatchObject({
        allowCollaborator: true,
        toolNetwork: false,
        collaborationRoundBudget: 2
      });
      expect(await fixture.captureGitState()).toEqual(before);
      expect(fixture.events.byType("task.created")).toHaveLength(1);
      expect(fixture.events.byType("approval.requested")).toHaveLength(1);
      expect(fixture.approvals.listForTask(result.task.id)).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("requires an explicit mentioned lead when both supported Agents are mentioned", async () => {
    const fixture = await createApprovedTaskFixture();
    try {
      await expect(fixture.service.createFromUserMessage({
        roomId: fixture.room.id,
        messageEventId: "event-2",
        text: "@Claude and @Codex compare",
        explicitLead: null,
        idempotencyKey: "message-2"
      })).rejects.toThrow("AMBIGUOUS_LEAD_PROVIDER");
      await expect(fixture.service.createFromUserMessage({
        roomId: fixture.room.id,
        messageEventId: "event-3",
        text: "@Claude work alone",
        explicitLead: "codex",
        idempotencyKey: "message-3"
      })).rejects.toThrow("LEAD_PROVIDER_NOT_MENTIONED");
    } finally {
      await fixture.cleanup();
    }
  });

  it("atomically persists and replays task plus pending request and trusted events", async () => {
    const fixture = await createApprovedTaskFixture();
    try {
      const input = {
        roomId: fixture.room.id,
        messageEventId: "event-replay",
        text: "@Codex implement parser",
        explicitLead: null,
        idempotencyKey: "message-replay"
      } as const;
      const first = await fixture.service.createFromUserMessage(input);
      const replay = await fixture.service.createFromUserMessage(input);
      expect(replay).toEqual(first);
      expect(fixture.events.byType("task.created")).toHaveLength(1);
      expect(fixture.events.byType("approval.requested")).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rolls back the task, request, events, and idempotency result together", async () => {
    const duplicateEventId = "40000000-0000-4000-8000-000000000001";
    const ids = ["task-atomic", "request-atomic", duplicateEventId, duplicateEventId];
    const fixture = await createApprovedTaskFixture({
      id: () => ids.shift() ?? "40000000-0000-4000-8000-000000000099"
    });
    try {
      await expect(fixture.service.createFromUserMessage({
        roomId: fixture.room.id,
        messageEventId: "event-atomic",
        text: "@Claude implement parser",
        explicitLead: null,
        idempotencyKey: "message-atomic"
      })).rejects.toThrow();
      expect(fixture.tasks.get("task-atomic")).toBeNull();
      expect(fixture.approvals.getRequest("request-atomic")).toBeNull();
      expect(fixture.events.all()).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("decides the displayed scope once, persists a receipt, and replays duplicates", async () => {
    const fixture = await createApprovedTaskFixture();
    try {
      const created = await fixture.service.createFromUserMessage({
        roomId: fixture.room.id,
        messageEventId: "event-approve",
        text: "@Claude implement parser",
        explicitLead: null,
        idempotencyKey: "message-approve"
      });
      await expect(fixture.service.decideScope({
        taskId: created.task.id,
        approvalRequestId: created.approvalRequest.id,
        decision: "approved",
        displayedScopeHash: hashCanonical({ ...created.approvalRequest.scope, toolNetwork: true }),
        workerGeneration: fixture.generation,
        idempotencyKey: "approve-scope"
      })).rejects.toThrow("APPROVAL_SCOPE_HASH_MISMATCH");

      const approved = await fixture.service.decideScope({
        taskId: created.task.id,
        approvalRequestId: created.approvalRequest.id,
        decision: "approved",
        displayedScopeHash: created.approvalRequest.scopeHash,
        workerGeneration: fixture.generation,
        idempotencyKey: "approve-scope"
      });
      const replay = await fixture.service.decideScope({
        taskId: created.task.id,
        approvalRequestId: created.approvalRequest.id,
        decision: "approved",
        displayedScopeHash: created.approvalRequest.scopeHash,
        workerGeneration: fixture.generation,
        idempotencyKey: "approve-scope"
      });
      expect(approved.state).toBe("Preparing");
      expect(replay).toEqual(approved);
      expect(fixture.approvals.listForTask(approved.id)).toHaveLength(1);
      expect(fixture.events.byType("approval.decided")).toHaveLength(1);
      expect(fixture.events.byType("task.transitioned")).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("grants additional rounds only through a new generation-bound receipt", async () => {
    const fixture = await createApprovedTaskFixture();
    try {
      const created = await fixture.service.createFromUserMessage({
        roomId: fixture.room.id,
        messageEventId: "event-round",
        text: "@Claude implement parser",
        explicitLead: null,
        idempotencyKey: "message-round"
      });
      let task = await fixture.service.decideScope({
        taskId: created.task.id,
        approvalRequestId: created.approvalRequest.id,
        decision: "approved",
        displayedScopeHash: created.approvalRequest.scopeHash,
        workerGeneration: fixture.generation,
        idempotencyKey: "approve-round-task"
      });
      task = fixture.tasks.applyTransition(
        transitionTask(task, { type: "preparationSucceeded" }),
        "41000000-0000-4000-8000-000000000001"
      );
      task = fixture.tasks.applyTransition(
        transitionTask(task, { type: "candidateReady", candidateId: "candidate-round" }),
        "41000000-0000-4000-8000-000000000002"
      );
      task = fixture.tasks.applyTransition(
        transitionTask(task, { type: "requestHumanApproval" }),
        "41000000-0000-4000-8000-000000000003"
      );
      const roundScope = { additionalRounds: 1 as const };
      const roundRequest = {
        id: "round-request-1",
        taskId: task.id,
        kind: "additional_round" as const,
        scope: roundScope,
        scopeHash: hashCanonical(roundScope),
        requestedGeneration: fixture.generation,
        status: "pending" as const,
        requestedAt: "2026-07-24T10:10:00.000Z"
      };
      fixture.approvals.insertRequest(roundRequest);

      const input = {
        taskId: task.id,
        approvalRequestId: roundRequest.id,
        additionalRounds: 1 as const,
        displayedScopeHash: roundRequest.scopeHash,
        workerGeneration: fixture.generation,
        idempotencyKey: "grant-round-1"
      };
      const granted = await fixture.service.grantAdditionalRounds(input);
      const replay = await fixture.service.grantAdditionalRounds(input);
      expect(granted).toMatchObject({
        state: "HumanApproval",
        collaborationRoundBudget: 3
      });
      expect(replay).toEqual(granted);
      expect(fixture.approvals.listForTask(task.id).at(-1)).toMatchObject({
        kind: "additional_round",
        decision: "approved",
        survivesWorkerRestart: false,
        workerGeneration: fixture.generation
      });
      expect(fixture.events.byType("approval.decided")).toHaveLength(2);
    } finally {
      await fixture.cleanup();
    }
  });
});
