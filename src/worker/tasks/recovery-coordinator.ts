import { access } from "node:fs/promises";
import type {
  RecoveryOperationPreview,
  RecoveryPreview,
  TaskRecord
} from "../../shared/contracts/domain";
import { hashCanonical } from "../approvals/canonical-json";
import type { ApprovalRepository } from "../approvals/approval-repository";
import type { GitOperationReconciler } from "../git/git-operation-reconciler";
import type { GitArtifactRepository } from "../git/git-artifact-repository";
import type { OperationJournal } from "../operations/operation-journal";
import type { EventStore } from "../storage/event-store";
import type { ProjectRepository } from "../storage/repositories";
import { transitionTask } from "./task-state-machine";
import type { TaskRepository } from "./task-repository";

export interface ResolveRecoveryInput {
  taskId: string;
  previewHash: `sha256:${string}`;
  decision: "resume_recorded_phase" | "keep_observed_state" | "cancel_and_retain";
  selectedOperationIds: string[];
  idempotencyKey: string;
}

interface RecoveryCoordinatorOptions {
  tasks: Pick<TaskRepository,
    "getRequired" | "listNonTerminal" | "applyTransition" | "listRuns" | "updateRunState">;
  approvals: Pick<ApprovalRepository, "invalidateSensitiveFromOlderGeneration">;
  operations: Pick<OperationJournal, "listIncomplete" | "reconcile">;
  artifacts: Pick<GitArtifactRepository, "listWorktrees" | "listCheckpoints">;
  projects: Pick<ProjectRepository, "findById">;
  reconciler: Pick<GitOperationReconciler, "observe">;
  events: EventStore;
  workerGeneration: string;
  renewFinalApproval?(taskId: string, idempotencyKey: string): Promise<void>;
  id(): string;
  now(): string;
}

function semanticPreviewHash(input: Omit<RecoveryPreview, "previewHash">): `sha256:${string}` {
  const { createdAt: _createdAt, ...semantic } = input;
  void _createdAt;
  return hashCanonical(semantic);
}

export class RecoveryCoordinator {
  private readonly previews = new Map<string, RecoveryPreview>();

  constructor(private readonly options: RecoveryCoordinatorOptions) {}

  getPreview(taskId: string): RecoveryPreview | null {
    return this.previews.get(taskId) ?? null;
  }

  async markInterruptedAfterGenerationChange(
    _previousGeneration: string,
    currentGeneration: string
  ): Promise<string[]> {
    this.options.approvals.invalidateSensitiveFromOlderGeneration(currentGeneration);
    const interrupted: string[] = [];
    for (const task of this.options.tasks.listNonTerminal()) {
      for (const run of this.options.tasks.listRuns(task.id)) {
        if (run.state === "starting" || run.state === "running") {
          this.options.tasks.updateRunState(run.id, "interrupted", this.options.now());
        }
      }
      if (task.state === "Interrupted" || task.state === "Reconciling") continue;
      this.options.tasks.applyTransition(
        transitionTask(
          { ...task, updatedAt: this.options.now() },
          { type: "processLoss", generation: currentGeneration }
        ),
        this.options.id()
      );
      interrupted.push(task.id);
    }
    return interrupted;
  }

  async preview(taskId: string): Promise<RecoveryPreview> {
    let task = this.options.tasks.getRequired(taskId);
    if (task.state === "Interrupted") {
      task = this.options.tasks.applyTransition(
        transitionTask(
          { ...task, updatedAt: this.options.now() },
          { type: "beginReconciliation" }
        ),
        this.options.id()
      );
    }
    if (task.state !== "Reconciling") throw new Error("TASK_NOT_INTERRUPTED");
    const operations = await this.observeOperations(taskId);
    const project = this.options.projects.findById(task.projectId);
    let repositoryAvailable = false;
    if (project) {
      try {
        await access(project.repositoryRoot);
        repositoryAvailable = true;
      } catch {
        repositoryAvailable = false;
      }
    }
    const withoutHash: Omit<RecoveryPreview, "previewHash"> = {
      taskId,
      recordedPhase: task.interruptedFromState,
      repositoryAvailable,
      worktrees: this.options.artifacts.listWorktrees(taskId),
      checkpoints: this.options.artifacts.listCheckpoints(taskId),
      dirtyPaths: [],
      providerSessionResumable: this.options.tasks.listRuns(taskId)
        .some((run) => run.state === "interrupted" && run.providerSessionId !== null),
      operations,
      createdAt: this.options.now()
    };
    const preview: RecoveryPreview = {
      ...withoutHash,
      previewHash: semanticPreviewHash(withoutHash)
    };
    this.previews.set(taskId, preview);
    this.options.events.append({
      id: this.options.id(),
      roomId: task.roomId,
      type: "task.recovery",
      actor: "system",
      payload: { preview },
      createdAt: preview.createdAt
    });
    return preview;
  }

  async resolve(input: ResolveRecoveryInput): Promise<TaskRecord> {
    const task = this.options.tasks.getRequired(input.taskId);
    if (task.state !== "Reconciling") throw new Error("TASK_NOT_RECONCILING");
    const cached = this.previews.get(input.taskId);
    if (!cached || cached.previewHash !== input.previewHash) throw new Error("RECOVERY_PREVIEW_HASH_MISMATCH");
    const freshOperations = await this.observeOperations(input.taskId);
    const selected = new Set(input.selectedOperationIds);
    if ([...selected].some((operationId) => !freshOperations.some(({ operationId: id }) => id === operationId))) {
      throw new Error("RECOVERY_OPERATION_SELECTION_INVALID");
    }
    const { previewHash: _cachedHash, ...cachedWithoutHash } = cached;
    void _cachedHash;
    const freshHash = semanticPreviewHash({
      ...cachedWithoutHash,
      operations: freshOperations,
      createdAt: cached.createdAt
    });
    if (freshHash !== input.previewHash) throw new Error("RECOVERY_PREVIEW_STALE");

    for (const operation of freshOperations) {
      if (!selected.has(operation.operationId) && input.decision !== "keep_observed_state") continue;
      this.options.operations.reconcile(
        operation.operationId,
        operation.actual,
        operation.outcome
      );
    }
    let target: TaskRecord["interruptedFromState"] | "Completed" | "HumanApproval" | "Cancelled";
    if (input.decision === "cancel_and_retain") {
      target = "Cancelled";
    } else if (input.decision === "resume_recorded_phase") {
      target = task.interruptedFromState;
      if (target === null) throw new Error("RECOVERY_RECORDED_PHASE_MISSING");
    } else if (task.interruptedFromState === "Merging") {
      target = freshOperations.some((operation) =>
        operation.operationType.startsWith("merge.") && operation.outcome === "applied")
        ? "Completed"
        : "HumanApproval";
    } else {
      target = task.interruptedFromState ?? "HumanApproval";
    }
    const resolved = this.options.tasks.applyTransition(
      transitionTask(
        { ...task, updatedAt: this.options.now() },
        { type: "resumeRecordedPhase", target }
      ),
      this.options.id()
    );
    if (resolved.state === "HumanApproval") {
      await this.options.renewFinalApproval?.(
        resolved.id,
        `${input.idempotencyKey}:renew-final-approval`
      );
    }
    this.previews.delete(input.taskId);
    return resolved;
  }

  private async observeOperations(taskId: string): Promise<RecoveryOperationPreview[]> {
    const records = this.options.operations.listIncomplete()
      .filter((record) => record.taskId === taskId);
    const observed = [];
    for (const record of records) {
      const operation = await this.options.reconciler.observe(record);
      observed.push({
        operationId: operation.operationId,
        operationType: operation.operationType,
        outcome: operation.outcome,
        expected: operation.expected,
        actual: operation.actual
      });
    }
    return observed;
  }
}
