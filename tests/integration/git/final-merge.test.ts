import { expect, it } from "vitest";
import { createFinalMergeFixture } from "../../fixtures/task-engine";

it("fast-forwards the real clean checkout owner only after exact final approval", async () => {
  const fixture = await createFinalMergeFixture({ targetCheckedOut: true });
  try {
    const result = await fixture.merge.mergeApprovedCandidate({
      taskId: "task-1",
      approvalId: fixture.approval.id,
      workerGeneration: fixture.generation,
      idempotencyKey: "merge-checked-out"
    });
    expect(result).toMatchObject({ outcome: "completed", mode: "checked_out_ff_only" });
    expect(await fixture.targetOid()).toBe(fixture.candidate.candidateOid);
    expect(await fixture.ownerHeadOid()).toBe(fixture.candidate.candidateOid);
    expect(fixture.tasks.getRequired("task-1").state).toBe("Completed");
  } finally {
    await fixture.cleanup();
  }
});

it("blocks a dirty checkout owner without stash, reset, clean, or checkout", async () => {
  const fixture = await createFinalMergeFixture({ targetCheckedOut: true, dirty: true });
  try {
    await expect(fixture.merge.mergeApprovedCandidate({
      taskId: "task-1",
      approvalId: fixture.approval.id,
      workerGeneration: fixture.generation,
      idempotencyKey: "merge-dirty"
    })).rejects.toThrow("TARGET_WORKTREE_DIRTY");
    expect(await fixture.targetOid()).toBe(fixture.repository.initialOid);
    expect(fixture.tasks.getRequired("task-1").state).toBe("HumanApproval");
    expect(fixture.gitCommandCalls().flat()).not.toEqual(
      expect.arrayContaining(["stash", "reset", "clean"])
    );
  } finally {
    await fixture.cleanup();
  }
});
