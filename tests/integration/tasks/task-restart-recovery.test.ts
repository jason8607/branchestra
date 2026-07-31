import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { GitArtifactRepository } from "../../../src/worker/git/git-artifact-repository";
import { RecoveryCoordinator } from "../../../src/worker/tasks/recovery-coordinator";
import { createEventStore } from "../../../src/worker/storage/event-store";
import { createRepositories } from "../../../src/worker/storage/repositories";
import { openTestDatabase } from "../../fixtures/test-database";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(outcome: "applied" | "not_applied" | "conflict" | "uncertain") {
  const testDb = openTestDatabase();
  directories.push(testDb.directory);
  const repositories = createRepositories(testDb.db);
  repositories.tasks.insert({
    ...testDb.records.task,
    state: "Interrupted",
    interruptedFromState: "Merging"
  });
  repositories.operations.recordIntent({
    ...testDb.records.operationIntent,
    id: "merge-operation-1",
    idempotencyKey: "merge-operation-key",
    operationType: "merge.update_ref_cas",
    expected: {
      targetRef: "refs/heads/main",
      baseOid: "a".repeat(40),
      candidateOid: "b".repeat(40)
    }
  });
  let observations = 0;
  const recovery = new RecoveryCoordinator({
    tasks: repositories.tasks,
    approvals: repositories.approvals,
    operations: repositories.operations,
    artifacts: new GitArtifactRepository(testDb.db),
    projects: repositories.projects,
    reconciler: {
      async observe(record) {
        observations += 1;
        return {
          operationId: record.id,
          operationType: record.operationType,
          outcome,
          expected: record.expected as Record<string, string>,
          actual: { targetOid: outcome === "applied" ? "b".repeat(40) : "a".repeat(40) },
          safeResolution: outcome === "applied" ? "mark_complete" as const : "keep_pending" as const
        };
      }
    },
    events: createEventStore(testDb.db, repositories),
    workerGeneration: "50000000-0000-4000-8000-000000000001",
    id: randomUUID,
    now: () => new Date().toISOString()
  });
  return { testDb, repositories, recovery, observations: () => observations };
}

describe("task restart recovery", () => {
  it.each([
    ["applied", "Completed"],
    ["not_applied", "HumanApproval"],
    ["conflict", "HumanApproval"]
  ] as const)("adopts an observed interrupted merge outcome: %s", async (outcome, expectedState) => {
    const current = fixture(outcome);
    try {
      const preview = await current.recovery.preview("task-1");
      expect(current.repositories.tasks.getRequired("task-1").state).toBe("Reconciling");
      expect(preview.operations).toEqual([
        expect.objectContaining({ operationType: "merge.update_ref_cas", outcome })
      ]);
      await current.recovery.resolve({
        taskId: "task-1",
        previewHash: preview.previewHash,
        decision: "keep_observed_state",
        selectedOperationIds: ["merge-operation-1"],
        idempotencyKey: `resolve-${outcome}`
      });
      expect(current.repositories.tasks.getRequired("task-1").state).toBe(expectedState);
      expect(current.observations()).toBe(2);
    } finally {
      current.testDb.db.close();
    }
  });

  it("requires the exact preview hash and can cancel while retaining artifacts", async () => {
    const current = fixture("uncertain");
    try {
      const preview = await current.recovery.preview("task-1");
      await expect(current.recovery.resolve({
        taskId: "task-1",
        previewHash: `sha256:${"0".repeat(64)}`,
        decision: "cancel_and_retain",
        selectedOperationIds: [],
        idempotencyKey: "bad-preview"
      })).rejects.toThrow("RECOVERY_PREVIEW_HASH_MISMATCH");
      await current.recovery.resolve({
        taskId: "task-1",
        previewHash: preview.previewHash,
        decision: "cancel_and_retain",
        selectedOperationIds: [],
        idempotencyKey: "cancel-retain"
      });
      expect(current.repositories.tasks.getRequired("task-1").state).toBe("Cancelled");
    } finally {
      current.testDb.db.close();
    }
  });
});
