import { describe, expect, it } from "vitest";
import { createIntegrationFixture } from "../../fixtures/task-engine";

const GENERATION = "00000000-0000-4000-8000-000000000001";

describe("Lead checkpoint integration", { timeout: 60_000 }, () => {
  it("cherry-picks only a selected immutable Collaborator checkpoint through GitManager", async () => {
    const fixture = await createIntegrationFixture({ conflict: false });
    try {
      const result = await fixture.integration.integrateSelectedCheckpoints({
        taskId: "task-1",
        leadWorktree: fixture.lead,
        selectedCheckpointIds: ["collaborator-cp-1"],
        workerGeneration: GENERATION,
        idempotencyKey: "integrate-1"
      });
      expect(result).toMatchObject({
        outcome: "integrated",
        sourceOids: [fixture.collaboratorCheckpoint.oid]
      });
      expect(await fixture.readLead("collaborator.txt")).toBe("alternative\n");
      expect(fixture.providerGitMutationCalls()).toEqual([]);
      expect(fixture.events.byType("checkpoint.integrated").at(-1)?.payload)
        .toMatchObject({ taskId: "task-1", sourceOids: [fixture.collaboratorCheckpoint.oid] });
      await expect(fixture.integration.integrateSelectedCheckpoints({
        taskId: "task-1",
        leadWorktree: fixture.lead,
        selectedCheckpointIds: ["collaborator-cp-1"],
        workerGeneration: GENERATION,
        idempotencyKey: "integrate-1"
      })).resolves.toEqual(result);
      expect(fixture.events.byType("checkpoint.integrated")).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("supports zero, one, or multiple selected checkpoints while preserving declared order", async () => {
    const empty = await createIntegrationFixture({ conflict: false });
    try {
      const headBefore = await empty.gitAtLead("rev-parse", "HEAD");
      await expect(empty.integration.integrateSelectedCheckpoints({
        taskId: "task-1",
        leadWorktree: empty.lead,
        selectedCheckpointIds: [],
        workerGeneration: GENERATION,
        idempotencyKey: "integrate-zero"
      })).resolves.toEqual({
        outcome: "integrated",
        sourceOids: [],
        headOid: headBefore
      });
    } finally {
      await empty.cleanup();
    }

    const multiple = await createIntegrationFixture({ conflict: false, multiple: true });
    try {
      const selectedCheckpointIds = multiple.collaboratorCheckpoints.map(({ id }) => id);
      const result = await multiple.integration.integrateSelectedCheckpoints({
        taskId: "task-1",
        leadWorktree: multiple.lead,
        selectedCheckpointIds,
        workerGeneration: GENERATION,
        idempotencyKey: "integrate-multiple"
      });
      expect(result.sourceOids).toEqual(
        multiple.collaboratorCheckpoints.map(({ oid }) => oid)
      );
      expect(await multiple.readLead("second.txt")).toBe("second\n");
    } finally {
      await multiple.cleanup();
    }
  });

  it("rejects duplicate, cross-task, and externally moved checkpoint refs before mutation", async () => {
    const fixture = await createIntegrationFixture({
      conflict: false,
      foreignCheckpoint: true
    });
    try {
      const headBefore = await fixture.gitAtLead("rev-parse", "HEAD");
      await expect(fixture.integration.integrateSelectedCheckpoints({
        taskId: "task-1",
        leadWorktree: fixture.lead,
        selectedCheckpointIds: ["collaborator-cp-1", "collaborator-cp-1"],
        workerGeneration: GENERATION,
        idempotencyKey: "integrate-duplicate"
      })).rejects.toThrow("DUPLICATE_CHECKPOINT_SELECTION");
      await expect(fixture.integration.integrateSelectedCheckpoints({
        taskId: "task-1",
        leadWorktree: fixture.lead,
        selectedCheckpointIds: [fixture.foreignCheckpoint!.id],
        workerGeneration: GENERATION,
        idempotencyKey: "integrate-foreign"
      })).rejects.toThrow("CHECKPOINT_TASK_MISMATCH");
      await fixture.repository.run([
        "update-ref",
        fixture.collaboratorCheckpoint.immutableRef,
        fixture.repository.initialOid
      ]);
      await expect(fixture.integration.integrateSelectedCheckpoints({
        taskId: "task-1",
        leadWorktree: fixture.lead,
        selectedCheckpointIds: ["collaborator-cp-1"],
        workerGeneration: GENERATION,
        idempotencyKey: "integrate-moving-ref"
      })).rejects.toThrow("IMMUTABLE_CHECKPOINT_REF_CONFLICT");
      expect(await fixture.gitAtLead("rev-parse", "HEAD")).toBe(headBefore);
    } finally {
      await fixture.cleanup();
    }
  });

  it("preserves cherry-pick conflict state for Lead resolution and GitManager continuation", async () => {
    const fixture = await createIntegrationFixture({ conflict: true });
    try {
      const result = await fixture.integration.integrateSelectedCheckpoints({
        taskId: "task-1",
        leadWorktree: fixture.lead,
        selectedCheckpointIds: ["collaborator-cp-1"],
        workerGeneration: GENERATION,
        idempotencyKey: "integrate-conflict"
      });
      expect(result).toMatchObject({
        outcome: "conflict",
        files: ["shared.txt"],
        sourceOids: [fixture.collaboratorCheckpoint.oid]
      });
      expect(fixture.tasks.getRequired("task-1").state).toBe("Revision");
      expect(await fixture.gitAtLead("rev-parse", "CHERRY_PICK_HEAD"))
        .toBe(fixture.collaboratorCheckpoint.oid);
      expect(fixture.artifacts.getWorktree("task-1", "lead")).toMatchObject({
        id: fixture.lead.id,
        retained: true
      });
      expect(fixture.events.byType("integration.conflict").at(-1)?.payload)
        .toMatchObject({ files: ["shared.txt"] });
      await expect(fixture.integration.integrateSelectedCheckpoints({
        taskId: "task-1",
        leadWorktree: fixture.lead,
        selectedCheckpointIds: ["collaborator-cp-1"],
        workerGeneration: GENERATION,
        idempotencyKey: "integrate-conflict"
      })).resolves.toEqual(result);
      expect(fixture.events.byType("integration.conflict")).toHaveLength(1);

      await fixture.writeLead("shared.txt", "resolved\n");
      const continued = await fixture.manager.continueIntegration({
        projectId: fixture.project.id,
        taskId: "task-1",
        leadWorktree: fixture.lead,
        expectedSourceOid: fixture.collaboratorCheckpoint.oid,
        workerGeneration: GENERATION,
        idempotencyKey: "continue-conflict"
      });
      expect(continued.headOid).toMatch(/^[0-9a-f]{40,64}$/);
      expect(await fixture.gitAtLead("status", "--porcelain=v2")).toBe("");
      expect(await fixture.readLead("shared.txt")).toBe("resolved\n");
      expect(fixture.gitMutationCalls()).not.toContain("cherry-pick --abort");
      expect(fixture.gitMutationCalls()).not.toContain("reset --hard");
    } finally {
      await fixture.cleanup();
    }
  });
});
