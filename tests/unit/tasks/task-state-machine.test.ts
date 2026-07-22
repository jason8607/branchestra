import { describe, expect, it } from "vitest";
import {
  NON_TERMINAL_TASK_STATES,
  transitionTask
} from "../../../src/worker/tasks/task-state-machine";
import type { TaskAction, TaskRecord, TaskState } from "../../../src/shared/contracts/domain";

const expectedSystemTargets: Record<
  Exclude<TaskState, "Completed" | "Cancelled" | "Failed">,
  { cancel: TaskState; fail: TaskState; processLoss: TaskState }
> = {
  AwaitingApproval: { cancel: "Cancelled", fail: "Failed", processLoss: "Interrupted" },
  Preparing: { cancel: "CancelRequested", fail: "Failed", processLoss: "Interrupted" },
  Working: { cancel: "CancelRequested", fail: "Failed", processLoss: "Interrupted" },
  Checkpoint: { cancel: "CancelRequested", fail: "Failed", processLoss: "Interrupted" },
  Review1: { cancel: "CancelRequested", fail: "Failed", processLoss: "Interrupted" },
  Revision: { cancel: "CancelRequested", fail: "Failed", processLoss: "Interrupted" },
  Review2: { cancel: "CancelRequested", fail: "Failed", processLoss: "Interrupted" },
  Candidate: { cancel: "CancelRequested", fail: "Failed", processLoss: "Interrupted" },
  HumanApproval: { cancel: "CancelRequested", fail: "Failed", processLoss: "Interrupted" },
  Merging: { cancel: "CancelRequested", fail: "Failed", processLoss: "Interrupted" },
  CancelRequested: { cancel: "CancelRequested", fail: "Failed", processLoss: "Interrupted" },
  Interrupted: { cancel: "Cancelled", fail: "Failed", processLoss: "Interrupted" },
  Reconciling: { cancel: "Cancelled", fail: "Failed", processLoss: "Interrupted" }
};

function task(state: TaskState, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1", roomId: "room-1", projectId: "project-1", requestEventId: "event-1",
    requestText: "@Claude fix it", leadProvider: "claude", targetRef: "refs/heads/main",
    baseOid: "a".repeat(40), state, interruptedFromState: null, collaborationRoundsUsed: 0,
    collaborationRoundBudget: 2, humanRevisionCount: 0, revisionKind: null,
    scopeApprovalId: null, activeCandidateId: null, failure: null, version: 1,
    createdAt: "2026-07-21T00:00:00.000Z", updatedAt: "2026-07-21T00:00:00.000Z",
    ...overrides
  };
}

describe("transitionTask system transitions", () => {
  it("covers cancel, failure, and process loss for every non-terminal state", () => {
    expect([...NON_TERMINAL_TASK_STATES].sort()).toEqual(Object.keys(expectedSystemTargets).sort());
    for (const state of NON_TERMINAL_TASK_STATES) {
      expect(transitionTask(task(state), { type: "cancel", reason: "user" }).next.state)
        .toBe(expectedSystemTargets[state].cancel);
      expect(transitionTask(task(state), { type: "fail", code: "RUN_FAILED", message: "boom" }).next.state)
        .toBe(expectedSystemTargets[state].fail);
      const interrupted = transitionTask(task(state), {
        type: "processLoss", generation: "00000000-0000-4000-8000-000000000009"
      }).next;
      expect(interrupted.state).toBe(expectedSystemTargets[state].processLoss);
      expect(interrupted.interruptedFromState).toBe(state === "Interrupted" ? null : state);
    }
  });

  it("enforces two automatic rounds and keeps human revisions out of the counter", () => {
    const first = transitionTask(task("Checkpoint"), {
      type: "beginReview", checkpointOid: "b".repeat(40)
    }).next;
    expect(first).toMatchObject({ state: "Review1", collaborationRoundsUsed: 1 });
    const second = transitionTask(task("Revision", { collaborationRoundsUsed: 1 }), {
      type: "beginReview", checkpointOid: "c".repeat(40)
    }).next;
    expect(second).toMatchObject({ state: "Review2", collaborationRoundsUsed: 2 });
    expect(() => transitionTask(task("Revision", { collaborationRoundsUsed: 2 }), {
      type: "beginReview", checkpointOid: "d".repeat(40)
    })).toThrow("COLLABORATION_ROUND_BUDGET_EXHAUSTED");
    const human = transitionTask(task("HumanApproval", { collaborationRoundsUsed: 2 }), {
      type: "requestHumanRevision", instruction: "rename the command"
    }).next;
    expect(human).toMatchObject({
      state: "Revision", collaborationRoundsUsed: 2, humanRevisionCount: 1,
      revisionKind: "human_directed"
    });
  });

  it("rejects an initial scope budget above two and emits only canonical transition facts", () => {
    expect(() => transitionTask(task("AwaitingApproval"), {
      type: "approveScope", receiptId: "receipt-1", collaborationRoundBudget: 3
    })).toThrow("INITIAL_COLLABORATION_ROUND_BUDGET_INVALID");
    expect(transitionTask(task("Preparing"), { type: "preparationSucceeded" }).event).toEqual({
      type: "task.transitioned", payload: { taskId: "task-1", from: "Preparing", to: "Working", version: 2 }
    });
  });

  it("requires an explicit additional-round receipt before reusing Review2", () => {
    const revision = task("Revision", { collaborationRoundsUsed: 2 });
    expect(() => transitionTask(revision, {
      type: "beginReview", checkpointOid: "b".repeat(40)
    })).toThrow("COLLABORATION_ROUND_BUDGET_EXHAUSTED");
    const granted = transitionTask(revision, {
      type: "grantAdditionalRounds", receiptId: "receipt-1", additionalRounds: 1
    }).next;
    expect(transitionTask(granted, {
      type: "beginReview", checkpointOid: "c".repeat(40)
    }).next).toMatchObject({ state: "Review2", collaborationRoundsUsed: 3 });
  });
});

describe("transitionTask normal transitions", () => {
  const normalTransitions: Array<[TaskState, TaskAction, TaskState]> = [
    ["AwaitingApproval", { type: "approveScope", receiptId: "receipt-1", collaborationRoundBudget: 2 }, "Preparing"],
    ["AwaitingApproval", { type: "rejectScope", receiptId: "receipt-1" }, "Cancelled"],
    ["Preparing", { type: "preparationSucceeded" }, "Working"],
    ["Working", { type: "checkpointReady", checkpointOid: "b".repeat(40) }, "Checkpoint"],
    ["Working", { type: "candidateReady", candidateId: "candidate-1" }, "Candidate"],
    ["Checkpoint", { type: "candidateReady", candidateId: "candidate-1" }, "Candidate"],
    ["Review1", { type: "requestAgentRevision", findings: ["rename"] }, "Revision"],
    ["Revision", { type: "candidateReady", candidateId: "candidate-1" }, "Candidate"],
    ["Review2", { type: "candidateReady", candidateId: "candidate-1" }, "Candidate"],
    ["Candidate", { type: "requestHumanApproval" }, "HumanApproval"],
    ["HumanApproval", { type: "approveMerge", receiptId: "receipt-1" }, "Merging"],
    ["Merging", { type: "mergeCompleted" }, "Completed"],
    ["HumanApproval", { type: "approvalInvalidated", reason: "stale" }, "HumanApproval"],
    ["Merging", { type: "approvalInvalidated", reason: "stale" }, "HumanApproval"],
    ["CancelRequested", { type: "cancelSettled" }, "Cancelled"],
    ["Interrupted", { type: "beginReconciliation" }, "Reconciling"]
  ];

  it.each(normalTransitions)("moves %s to %s", (state, action, target) => {
    expect(transitionTask(task(state), action).next.state).toBe(target);
  });

  it("rejects actions from terminal states", () => {
    for (const state of ["Completed", "Cancelled", "Failed"] as const) {
      expect(() => transitionTask(task(state), { type: "cancel", reason: "user" }))
        .toThrow(`TERMINAL_TASK:${state}`);
    }
  });

  it("only resumes the persisted interrupted phase unless resolving an explicit outcome", () => {
    const reconciling = task("Reconciling", { interruptedFromState: "Working" });
    expect(() => transitionTask(reconciling, {
      type: "resumeRecordedPhase", target: "Revision"
    })).toThrow("RECONCILIATION_TARGET_MISMATCH");
    expect(transitionTask(reconciling, {
      type: "resumeRecordedPhase", target: "Working"
    }).next).toMatchObject({ state: "Working", interruptedFromState: null });
    for (const target of ["Completed", "HumanApproval", "Cancelled"] as const) {
      expect(transitionTask(reconciling, { type: "resumeRecordedPhase", target }).next.state)
        .toBe(target);
    }
  });
});
