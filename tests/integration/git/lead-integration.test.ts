import { describe, expect, it } from "vitest";
import { createIntegrationFixture } from "../../fixtures/task-engine";

const GENERATION = "00000000-0000-4000-8000-000000000001";

describe("Lead checkpoint integration", { timeout: 180_000 }, () => {
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
      expect(fixture.gitCommandCalls().filter(
        ([command]) => command === "cherry-pick"
      )).toEqual([[
        "cherry-pick",
        "--no-gpg-sign",
        fixture.collaboratorCheckpoint.oid
      ]]);
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
      expect(multiple.gitCommandCalls().filter(
        ([command]) => command === "cherry-pick"
      )).toEqual(multiple.collaboratorCheckpoints.map(({ oid }) => [
        "cherry-pick",
        "--no-gpg-sign",
        oid
      ]));
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

  it("rejects an invalid task phase before any Git mutation", async () => {
    const fixture = await createIntegrationFixture({
      conflict: false,
      state: "Cancelled"
    });
    try {
      const headBefore = await fixture.gitAtLead("rev-parse", "HEAD");
      const commandCount = fixture.gitCommandCalls().length;
      await expect(fixture.integration.integrateSelectedCheckpoints({
        taskId: "task-1",
        leadWorktree: fixture.lead,
        selectedCheckpointIds: ["collaborator-cp-1"],
        workerGeneration: GENERATION,
        idempotencyKey: "integrate-terminal"
      })).rejects.toThrow("TASK_NOT_IN_INTEGRATION_PHASE:Cancelled");
      expect(await fixture.gitAtLead("rev-parse", "HEAD")).toBe(headBefore);
      expect(fixture.gitCommandCalls().slice(commandCount)
        .some(([command]) => command === "cherry-pick")).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("durably reserves the task version while selected checkpoints are integrating", async () => {
    const fixture = await createIntegrationFixture({
      conflict: false,
      pauseBeforeMutation: true
    });
    const integrating = fixture.integration.integrateSelectedCheckpoints({
      taskId: "task-1",
      leadWorktree: fixture.lead,
      selectedCheckpointIds: ["collaborator-cp-1"],
      workerGeneration: GENERATION,
      idempotencyKey: "integrate-reserved"
    });
    try {
      await fixture.waitUntilIntegrationReserved();
      const current = fixture.tasks.getRequired("task-1");
      expect(() => fixture.tasks.applyTransition({
        previous: current,
        next: {
          ...current,
          state: "CancelRequested",
          version: current.version + 1
        },
        event: {
          type: "task.transitioned",
          payload: {
            taskId: current.id,
            from: current.state,
            to: "CancelRequested",
            version: current.version + 1
          }
        }
      }, fixture.id())).toThrow("TASK_INTEGRATION_IN_PROGRESS");
      fixture.releaseIntegration();
      await expect(integrating).resolves.toMatchObject({ outcome: "integrated" });
    } finally {
      fixture.releaseIntegration();
      await integrating.catch(() => undefined);
      await fixture.cleanup();
    }
  });

  it("releases a reserved task after GitManager proves no integration intent exists", async () => {
    const fixture = await createIntegrationFixture({ conflict: false });
    const input = {
      taskId: "task-1",
      leadWorktree: fixture.lead,
      selectedCheckpointIds: ["collaborator-cp-1"],
      workerGeneration: GENERATION,
      idempotencyKey: "integrate-pre-intent-failure"
    };
    try {
      await fixture.writeLead("dirty.txt", "dirty\n");
      const firstError = await fixture.integration.integrateSelectedCheckpoints(input)
        .then(() => null, (error: unknown) => error);
      expect(firstError).toMatchObject({
        message: "LEAD_WORKTREE_NOT_CLEAN",
        disposition: "safe_to_fail_service_command"
      });
      expect(fixture.journal.getByIdempotencyKey(input.idempotencyKey)).toBeNull();
      expect(fixture.databaseFixture.db.prepare(`
        SELECT status, error_message
        FROM task_service_commands
        WHERE idempotency_key = ?
      `).get(input.idempotencyKey)).toEqual({
        status: "failed",
        error_message: "LEAD_WORKTREE_NOT_CLEAN"
      });

      const replayError = await fixture.integration.integrateSelectedCheckpoints(input)
        .then(() => null, (error: unknown) => error);
      expect(replayError).toMatchObject({ message: "LEAD_WORKTREE_NOT_CLEAN" });
      expect(fixture.gitCommandCalls().filter(
        ([command]) => command === "cherry-pick"
      )).toHaveLength(0);
      await expect(fixture.engine.cancel(
        "task-1",
        "user",
        "cancel-after-pre-intent-failure"
      )).resolves.toMatchObject({ state: "Cancelled" });
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps a reserved task locked when an integration intent makes Git state uncertain", async () => {
    const fixture = await createIntegrationFixture({ conflict: false });
    const input = {
      taskId: "task-1",
      leadWorktree: fixture.lead,
      selectedCheckpointIds: ["collaborator-cp-1"],
      workerGeneration: GENERATION,
      idempotencyKey: "integrate-post-intent-failure"
    };
    try {
      fixture.failAfterNextCherryPick();
      const firstError = await fixture.integration.integrateSelectedCheckpoints(input)
        .then(() => null, (error: unknown) => error);
      expect(firstError).toMatchObject({
        message: "CHECKPOINT_INTEGRATION_NEEDS_ATTENTION",
        disposition: "reconciliation_required"
      });
      expect(fixture.journal.getByIdempotencyKey(input.idempotencyKey))
        .toMatchObject({ status: "needs_attention" });
      expect(fixture.databaseFixture.db.prepare(`
        SELECT status, error_message
        FROM task_service_commands
        WHERE idempotency_key = ?
      `).get(input.idempotencyKey)).toEqual({
        status: "pending",
        error_message: null
      });
      const current = fixture.tasks.getRequired("task-1");
      expect(() => fixture.tasks.applyTransition({
        previous: current,
        next: {
          ...current,
          state: "CancelRequested",
          version: current.version + 1
        },
        event: {
          type: "task.transitioned",
          payload: {
            taskId: current.id,
            from: current.state,
            to: "CancelRequested",
            version: current.version + 1
          }
        }
      }, fixture.id())).toThrow("TASK_INTEGRATION_IN_PROGRESS");
      await expect(fixture.integration.integrateSelectedCheckpoints(input))
        .rejects.toThrow(
          "SERVICE_COMMAND_REQUIRES_RECONCILIATION:integrate-post-intent-failure"
        );
      expect(fixture.gitCommandCalls().filter(
        ([command]) => command === "cherry-pick"
      )).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("replays integration from its durable service command beyond the first event page", async () => {
    const fixture = await createIntegrationFixture({ conflict: false });
    try {
      fixture.appendNoiseEvents(501);
      const input = {
        taskId: "task-1",
        leadWorktree: fixture.lead,
        selectedCheckpointIds: ["collaborator-cp-1"],
        workerGeneration: GENERATION,
        idempotencyKey: "integrate-paged"
      };
      const first = await fixture.integration.integrateSelectedCheckpoints(input);
      await expect(fixture.integration.integrateSelectedCheckpoints(input))
        .resolves.toEqual(first);
      expect(fixture.events.byType("checkpoint.integrated")).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("atomically finalizes a conflict transition with its durable event", async () => {
    const fixture = await createIntegrationFixture({ conflict: true });
    try {
      fixture.databaseFixture.db.exec(`
        CREATE TRIGGER reject_integration_conflict
        BEFORE INSERT ON room_events
        WHEN NEW.event_type = 'integration.conflict'
        BEGIN
          SELECT RAISE(ABORT, 'INTEGRATION_EVENT_REJECTED');
        END;
      `);
      await expect(fixture.integration.integrateSelectedCheckpoints({
        taskId: "task-1",
        leadWorktree: fixture.lead,
        selectedCheckpointIds: ["collaborator-cp-1"],
        workerGeneration: GENERATION,
        idempotencyKey: "integrate-atomic-conflict"
      })).rejects.toThrow();
      expect(fixture.tasks.getRequired("task-1").state).toBe("Review2");
      expect(await fixture.gitAtLead("rev-parse", "CHERRY_PICK_HEAD"))
        .toBe(fixture.collaboratorCheckpoint.oid);
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

  it("re-observes the canonical Git common directory before continuing a conflict", async () => {
    const fixture = await createIntegrationFixture({ conflict: true });
    try {
      await fixture.integration.integrateSelectedCheckpoints({
        taskId: "task-1",
        leadWorktree: fixture.lead,
        selectedCheckpointIds: ["collaborator-cp-1"],
        workerGeneration: GENERATION,
        idempotencyKey: "integrate-common-dir"
      });
      await fixture.writeLead("shared.txt", "resolved\n");
      fixture.spoofNextContinueCommonDir("/tmp/branchestra-unexpected-common-dir");
      const commandCount = fixture.gitCommandCalls().length;
      await expect(fixture.manager.continueIntegration({
        projectId: fixture.project.id,
        taskId: "task-1",
        leadWorktree: fixture.lead,
        expectedSourceOid: fixture.collaboratorCheckpoint.oid,
        workerGeneration: GENERATION,
        idempotencyKey: "continue-common-dir"
      })).rejects.toThrow("REPOSITORY_IDENTITY_MISMATCH");
      expect(fixture.gitCommandCalls().slice(commandCount)
        .some(([command]) => command === "add" || command === "cherry-pick")).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });
});
