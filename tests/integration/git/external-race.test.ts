import { expect, it } from "vitest";
import { createFinalMergeFixture } from "../../fixtures/task-engine";

it("preserves an externally advanced unowned target and returns to HumanApproval", async () => {
  const fixture = await createFinalMergeFixture({ targetCheckedOut: false });
  try {
    const externalOid = await fixture.advanceTargetExternally();
    await expect(fixture.merge.mergeApprovedCandidate({
      taskId: "task-1",
      approvalId: fixture.approval.id,
      workerGeneration: fixture.generation,
      idempotencyKey: "merge-race"
    })).rejects.toThrow("TARGET_REF_CAS_FAILED");
    expect(await fixture.targetOid()).toBe(externalOid);
    expect(fixture.tasks.getRequired("task-1").state).toBe("HumanApproval");
  } finally {
    await fixture.cleanup();
  }
});

it("uses old-OID CAS when the target ref has no checkout owner", async () => {
  const fixture = await createFinalMergeFixture({ targetCheckedOut: false });
  try {
    await expect(fixture.merge.mergeApprovedCandidate({
      taskId: "task-1",
      approvalId: fixture.approval.id,
      workerGeneration: fixture.generation,
      idempotencyKey: "merge-cas"
    })).resolves.toMatchObject({ outcome: "completed", mode: "unowned_update_ref_cas" });
    expect(await fixture.targetOid()).toBe(fixture.candidate.candidateOid);
  } finally {
    await fixture.cleanup();
  }
});
