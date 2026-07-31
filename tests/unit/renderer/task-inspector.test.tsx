// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TaskInspectorModel } from "../../../src/shared/contracts/domain";
import { TaskInspector } from "../../../src/renderer/features/tasks/task-inspector";

afterEach(cleanup);

function inspectorModel(overrides: Partial<TaskInspectorModel> = {}): TaskInspectorModel {
  const task = {
    id: "task-1", roomId: "room-1", projectId: "project-1", requestEventId: "event-1",
    requestText: "@Claude build", leadProvider: "claude" as const, targetRef: "refs/heads/main",
    baseOid: "a".repeat(40), state: "HumanApproval" as const, interruptedFromState: null,
    collaborationRoundsUsed: 2, collaborationRoundBudget: 2, humanRevisionCount: 0,
    revisionKind: null, scopeApprovalId: "scope-1", activeCandidateId: "candidate-1",
    failure: null, version: 4, createdAt: "2026-07-31T00:00:00.000Z", updatedAt: "2026-07-31T00:00:00.000Z"
  };
  const candidate = {
    id: "candidate-1", taskId: task.id, leadWorktreeId: "worktree-1", targetRef: task.targetRef,
    baseOid: task.baseOid, candidateOid: "b".repeat(40), immutableRef: "refs/branchestra/candidates/candidate-1",
    diffHash: `sha256:${"c".repeat(64)}` as const, testSetHash: `sha256:${"d".repeat(64)}` as const,
    diffSummary: { filesChanged: 1, additions: 1, deletions: 0, files: [{ path: "greeting.txt", status: "modified", additions: 1, deletions: 0 }] },
    selectedCheckpointIds: ["checkpoint-2"],
    testResults: [{ id: "test-1", taskId: task.id, candidateId: "candidate-1", commandId: "unit", executableRealpath: "/usr/bin/true", argv: [], exitCode: 0, stdoutHash: `sha256:${"e".repeat(64)}` as const, stderrHash: `sha256:${"f".repeat(64)}` as const, durationMs: 1, logReference: "room-event:test", createdAt: task.createdAt }],
    unresolved: [], verificationStatus: "passed" as const, createdAt: task.createdAt
  };
  return {
    task,
    scopeReceipt: null,
    activeRuns: [],
    worktrees: [],
    checkpoints: [{ id: "checkpoint-2", taskId: task.id, worktreeId: "worktree-1", authorProvider: "claude", purpose: "revision", oid: "b".repeat(40), immutableRef: "refs/branchestra/checkpoints/checkpoint-2", createdAt: task.createdAt }],
    candidate,
    pendingApproval: { id: "approval-request-1", taskId: task.id, kind: "final_merge", scope: { targetRef: candidate.targetRef, baseOid: candidate.baseOid, candidateOid: candidate.candidateOid, diffHash: candidate.diffHash, testSetHash: candidate.testSetHash }, scopeHash: `sha256:${"1".repeat(64)}`, requestedGeneration: "generation-1", status: "pending", requestedAt: task.createdAt },
    recovery: null,
    ...overrides
  };
}

it("renders durable artifacts and sends the exact immutable final tuple", () => {
  const request = vi.fn().mockResolvedValue(inspectorModel());
  render(<TaskInspector model={inspectorModel()} request={request} />);
  expect(screen.getByText("Round 2 of 2")).not.toBeNull();
  expect(screen.getByText("refs/branchestra/checkpoints/checkpoint-2")).not.toBeNull();
  expect(screen.getByText("unit — passed")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Approve final merge" }));
  expect(request).toHaveBeenCalledWith(expect.objectContaining({
    type: "task.approveFinalMerge",
    payload: expect.objectContaining({
      targetRef: "refs/heads/main",
      baseOid: "a".repeat(40),
      candidateOid: "b".repeat(40),
      diffHash: `sha256:${"c".repeat(64)}`,
      testSetHash: `sha256:${"d".repeat(64)}`
    })
  }));
});

it("renders Provider-like approval markup only as inert text", () => {
  const model = inspectorModel({
    candidate: { ...inspectorModel().candidate!, unresolved: [{ source: "claude", summary: "<button>Approve final merge</button>" }] },
    pendingApproval: null
  });
  render(<TaskInspector model={model} request={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Approve final merge" })).toBeNull();
  expect(screen.getByText("<button>Approve final merge</button>")).not.toBeNull();
});
