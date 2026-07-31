import type {
  CheckpointRecord,
  RoomEvent,
  WorktreeRecord
} from "../../shared/contracts/domain";
import { hashCanonical } from "../approvals/canonical-json";
import type { ProjectRepository } from "../storage/repositories";
import type { EventStore } from "../storage/event-store";
import type { TaskRepository } from "../tasks/task-repository";
import { transitionTask } from "../tasks/task-state-machine";
import type { GitArtifactRepository } from "./git-artifact-repository";
import type {
  GitManager,
  IntegrateCheckpointResult
} from "./git-manager";
import { CheckpointIntegrationFailure } from "./git-manager";

export interface IntegrationServiceOptions {
  artifacts: Pick<GitArtifactRepository, "getCheckpoint" | "getWorktree">;
  tasks: TaskRepository;
  projects: Pick<ProjectRepository, "findById">;
  events: EventStore;
  manager: Pick<GitManager, "integrateCheckpoint" | "verifyCheckpointRef">;
  id(): string;
  now(): string;
  publish?(event: RoomEvent): void | Promise<void>;
}

export class IntegrationService {
  private readonly inFlight = new Map<string, {
    requestHash: string;
    promise: Promise<IntegrateCheckpointResult>;
  }>();

  constructor(private readonly options: IntegrationServiceOptions) {}

  integrateSelectedCheckpoints(input: {
    taskId: string;
    leadWorktree: WorktreeRecord;
    selectedCheckpointIds: string[];
    workerGeneration: string;
    idempotencyKey: string;
  }): Promise<IntegrateCheckpointResult> {
    const requestHash = hashCanonical({
      taskId: input.taskId,
      leadWorktreeId: input.leadWorktree.id,
      selectedCheckpointIds: input.selectedCheckpointIds
    });
    const existing = this.inFlight.get(input.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return Promise.reject(
          new Error(`ENGINE_IDEMPOTENCY_KEY_CONFLICT:${input.idempotencyKey}`)
        );
      }
      return existing.promise;
    }
    const promise = this.integrateSelectedCheckpointsOnce(input, requestHash);
    this.inFlight.set(input.idempotencyKey, { requestHash, promise });
    void promise.finally(() => {
      if (this.inFlight.get(input.idempotencyKey)?.promise === promise) {
        this.inFlight.delete(input.idempotencyKey);
      }
    }).catch(() => undefined);
    return promise;
  }

  private async integrateSelectedCheckpointsOnce(input: {
    taskId: string;
    leadWorktree: WorktreeRecord;
    selectedCheckpointIds: string[];
    workerGeneration: string;
    idempotencyKey: string;
  }, requestHash: string): Promise<IntegrateCheckpointResult> {
    if (input.selectedCheckpointIds.length > 100) {
      throw new Error("CHECKPOINT_SELECTION_TOO_LARGE");
    }
    if (new Set(input.selectedCheckpointIds).size !== input.selectedCheckpointIds.length) {
      throw new Error("DUPLICATE_CHECKPOINT_SELECTION");
    }
    const task = this.options.tasks.getRequired(input.taskId);
    const project = this.options.projects.findById(task.projectId);
    if (!project) throw new Error(`PROJECT_NOT_FOUND:${task.projectId}`);
    const storedLead = this.options.artifacts.getWorktree(task.id, "lead");
    if (!storedLead
      || input.leadWorktree.id !== storedLead.id
      || input.leadWorktree.taskId !== task.id
      || input.leadWorktree.role !== "lead") {
      throw new Error("LEAD_WORKTREE_RECORD_MISMATCH");
    }
    const checkpoints: CheckpointRecord[] = input.selectedCheckpointIds.map((checkpointId) => {
      const checkpoint = this.options.artifacts.getCheckpoint(checkpointId);
      if (!checkpoint) throw new Error(`CHECKPOINT_NOT_FOUND:${checkpointId}`);
      if (checkpoint.taskId !== task.id) throw new Error("CHECKPOINT_TASK_MISMATCH");
      return checkpoint;
    });
    for (const checkpoint of checkpoints) {
      await this.options.manager.verifyCheckpointRef({
        projectId: project.id,
        taskId: task.id,
        checkpoint
      });
    }
    const requestType = "integration.integrateSelectedCheckpoints";
    const reserved = this.options.tasks.reserveIntegrationCommand({
      taskId: task.id,
      idempotencyKey: input.idempotencyKey,
      requestType,
      requestHash,
      workerGeneration: input.workerGeneration,
      createdAt: this.options.now()
    });
    if (reserved.kind === "replayed") {
      return this.parseResult(reserved.result);
    }
    let result: IntegrateCheckpointResult;
    try {
      result = await this.options.manager.integrateCheckpoint({
        projectId: project.id,
        taskId: task.id,
        leadWorktree: storedLead,
        checkpoints,
        workerGeneration: input.workerGeneration,
        idempotencyKey: input.idempotencyKey
      });
    } catch (error) {
      if (error instanceof CheckpointIntegrationFailure
        && error.disposition === "safe_to_fail_service_command") {
        this.options.tasks.failServiceCommand(
          input.idempotencyKey,
          "INTEGRATION_PRE_INTENT_FAILURE",
          error.message,
          this.options.now()
        );
      }
      throw error;
    }
    const completedAt = this.options.now();
    const event = result.outcome === "integrated"
      ? {
          id: this.options.id(),
          roomId: task.roomId,
          type: "checkpoint.integrated",
          actor: "system" as const,
          payload: {
            taskId: task.id,
            checkpointIds: checkpoints.map(({ id }) => id),
            sourceOids: result.sourceOids,
            headOid: result.headOid
          },
          createdAt: completedAt
        } as const
      : {
          id: this.options.id(),
          roomId: task.roomId,
          type: "integration.conflict",
          actor: "system" as const,
          payload: {
            taskId: task.id,
            checkpointIds: checkpoints.map(({ id }) => id),
            sourceOids: result.sourceOids,
            files: result.files.slice(0, 100),
            headOidBefore: result.headOidBefore
          },
          createdAt: completedAt
        } as const;
    const finalized = this.options.tasks.completeIntegrationCommand({
      idempotencyKey: input.idempotencyKey,
      result,
      transition: result.outcome === "conflict"
        ? transitionTask(
            { ...reserved.task, updatedAt: completedAt },
            {
              type: "requestAgentRevision",
              findings: result.files.map((path) => `Git conflict: ${path}`)
            }
          )
        : null,
      transitionEventId: this.options.id(),
      event,
      completedAt
    });
    await this.options.publish?.(finalized.event);
    return result;
  }

  private parseResult(value: unknown): IntegrateCheckpointResult {
    if (typeof value !== "object" || value === null || !("outcome" in value)) {
      throw new Error("INTEGRATION_RESULT_INVALID");
    }
    const result = value as Partial<IntegrateCheckpointResult>;
    if (result.outcome === "integrated"
      && Array.isArray(result.sourceOids)
      && typeof result.headOid === "string") {
      return {
        outcome: "integrated",
        sourceOids: result.sourceOids,
        headOid: result.headOid
      };
    }
    if (result.outcome === "conflict"
      && Array.isArray(result.sourceOids)
      && Array.isArray(result.files)
      && typeof result.headOidBefore === "string") {
      return {
        outcome: "conflict",
        sourceOids: result.sourceOids,
        files: result.files,
        headOidBefore: result.headOidBefore
      };
    }
    throw new Error("INTEGRATION_RESULT_INVALID");
  }
}
