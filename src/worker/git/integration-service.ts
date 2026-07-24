import type {
  CheckpointRecord,
  RoomEvent,
  TaskRecord,
  WorktreeRecord
} from "../../shared/contracts/domain";
import type { ProjectRepository } from "../storage/repositories";
import type { EventStore } from "../storage/event-store";
import type { TaskRepository } from "../tasks/task-repository";
import { transitionTask } from "../tasks/task-state-machine";
import type { GitArtifactRepository } from "./git-artifact-repository";
import type {
  GitManager,
  IntegrateCheckpointResult
} from "./git-manager";

export interface IntegrationServiceOptions {
  artifacts: Pick<GitArtifactRepository, "getCheckpoint" | "getWorktree">;
  tasks: Pick<TaskRepository, "getRequired" | "applyTransition">;
  projects: Pick<ProjectRepository, "findById">;
  events: EventStore;
  manager: Pick<GitManager, "integrateCheckpoint">;
  id(): string;
  now(): string;
  publish?(event: RoomEvent): void | Promise<void>;
}

export class IntegrationService {
  constructor(private readonly options: IntegrationServiceOptions) {}

  async integrateSelectedCheckpoints(input: {
    taskId: string;
    leadWorktree: WorktreeRecord;
    selectedCheckpointIds: string[];
    workerGeneration: string;
    idempotencyKey: string;
  }): Promise<IntegrateCheckpointResult> {
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
    const result = await this.options.manager.integrateCheckpoint({
      projectId: project.id,
      taskId: task.id,
      leadWorktree: storedLead,
      checkpoints,
      workerGeneration: input.workerGeneration,
      idempotencyKey: input.idempotencyKey
    });
    const existingEvent = this.options.events.after({
      roomId: task.roomId,
      roomSeq: 0,
      limit: 500
    }).events.find((event) => {
      if (result.outcome === "integrated") {
        return event.type === "checkpoint.integrated"
          && event.payload.taskId === task.id
          && event.payload.headOid === result.headOid
          && this.sameOrder(event.payload.checkpointIds, input.selectedCheckpointIds)
          && this.sameOrder(event.payload.sourceOids, result.sourceOids);
      }
      return event.type === "integration.conflict"
        && event.payload.taskId === task.id
        && event.payload.headOidBefore === result.headOidBefore
        && this.sameOrder(event.payload.checkpointIds, input.selectedCheckpointIds)
        && this.sameOrder(event.payload.sourceOids, result.sourceOids)
        && this.sameOrder(event.payload.files, result.files);
    });
    if (existingEvent) return result;
    let durableTask: TaskRecord = task;
    if (result.outcome === "conflict") {
      durableTask = this.options.tasks.applyTransition(
        transitionTask(
          { ...this.options.tasks.getRequired(task.id), updatedAt: this.options.now() },
          {
            type: "requestAgentRevision",
            findings: result.files.map((path) => `Git conflict: ${path}`)
          }
        ),
        this.options.id()
      );
    }
    const event = result.outcome === "integrated"
      ? this.options.events.append({
          id: this.options.id(),
          roomId: durableTask.roomId,
          type: "checkpoint.integrated",
          actor: "system",
          payload: {
            taskId: task.id,
            checkpointIds: checkpoints.map(({ id }) => id),
            sourceOids: result.sourceOids,
            headOid: result.headOid
          },
          createdAt: this.options.now()
        })
      : this.options.events.append({
          id: this.options.id(),
          roomId: durableTask.roomId,
          type: "integration.conflict",
          actor: "system",
          payload: {
            taskId: task.id,
            checkpointIds: checkpoints.map(({ id }) => id),
            sourceOids: result.sourceOids,
            files: result.files.slice(0, 100),
            headOidBefore: result.headOidBefore
          },
          createdAt: this.options.now()
        });
    await this.options.publish?.(event);
    return result;
  }

  private sameOrder(left: string[], right: string[]): boolean {
    return left.length === right.length
      && left.every((value, index) => value === right[index]);
  }
}
