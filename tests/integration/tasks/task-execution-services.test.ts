import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitArtifactRepository } from "../../../src/worker/git/git-artifact-repository";
import type { GitManager } from "../../../src/worker/git/git-manager";
import { IntegrationService } from "../../../src/worker/git/integration-service";
import { JournaledOperationRunner } from "../../../src/worker/operations/journaled-operation-runner";
import {
  createDefaultTaskProvider
} from "../../../src/worker/providers/unavailable-provider";
import { CollaborationCoordinator } from "../../../src/worker/tasks/collaboration-coordinator";
import {
  createTaskExecutionServices
} from "../../../src/worker/tasks/task-execution-services";
import { TaskEngine } from "../../../src/worker/tasks/task-engine";
import { createApprovedTaskFixture } from "../../fixtures/task-engine";

describe("production task execution composition", () => {
  it("shares the sole TaskEngine supervisor across production collaboration services", async () => {
    const fixture = await createApprovedTaskFixture();
    try {
      const artifacts = new GitArtifactRepository(fixture.databaseFixture.db);
      const operations = new JournaledOperationRunner(
        fixture.repositories.operations
      );
      const manager = {
        ensureAgentWorktree: async () => {
          throw new Error("NOT_USED");
        },
        createCheckpoint: async () => {
          throw new Error("NOT_USED");
        },
        getReadService: () => {
          throw new Error("NOT_USED");
        },
        verifyCheckpointRef: async () => {
          throw new Error("NOT_USED");
        },
        integrateCheckpoint: async () => {
          throw new Error("NOT_USED");
        }
      } as unknown as GitManager;
      const provider = createDefaultTaskProvider();
      const services = createTaskExecutionServices({
        repositories: fixture.repositories,
        artifacts,
        events: fixture.eventStore,
        manager,
        provider,
        operations,
        workerGeneration: fixture.generation,
        contextVersion: 1,
        contextHash: `sha256:${"1".repeat(64)}`,
        id: randomUUID,
        now: fixture.now
      });

      expect(services.engine).toBeInstanceOf(TaskEngine);
      expect(services.collaboration).toBeInstanceOf(CollaborationCoordinator);
      expect(services.integration).toBeInstanceOf(IntegrationService);
      expect((services.collaboration as unknown as {
        options: { engine: TaskEngine };
      }).options.engine).toBe(services.engine);
      await expect(provider.startRun({
        runId: "run-unavailable",
        taskId: "task-1",
        roomId: fixture.room.id,
        provider: "claude",
        role: "lead",
        worktreePath: fixture.project.repositoryRoot,
        instruction: "must not execute",
        contextVersion: 1,
        contextHash: `sha256:${"1".repeat(64)}`,
        checkpointOid: null,
        approvedCapabilities: {
          workspaceRootRealpath: fixture.project.repositoryRoot,
          readableRootsRealpath: [fixture.project.repositoryRoot],
          commandClasses: [],
          toolNetwork: false,
          allowCollaborator: false,
          maxRunMs: 1_000
        }
      })).rejects.toThrow("PROVIDER_UNAVAILABLE");
    } finally {
      await fixture.cleanup();
    }
  });
});
