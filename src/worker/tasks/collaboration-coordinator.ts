import type {
  ApprovalReceipt,
  RoomEvent,
  TaskRecord
} from "../../shared/contracts/domain";
import { hashCanonical } from "../approvals/canonical-json";
import type { GitArtifactRepository } from "../git/git-artifact-repository";
import type { GitManager } from "../git/git-manager";
import type { EventStore } from "../storage/event-store";
import type { DomainRepositories } from "../storage/repositories";
import type { TaskEngine } from "./task-engine";
import { transitionTask } from "./task-state-machine";

export interface RequestRoundInput {
  taskId: string;
  purpose: "parallel_implementation" | "review";
  idempotencyKey: string;
}

export interface CollaborationCoordinatorOptions {
  repositories: DomainRepositories;
  artifacts: GitArtifactRepository;
  events: EventStore;
  manager: Pick<GitManager,
    "ensureAgentWorktree" | "getReadService" | "verifyCheckpointRef">;
  engine: Pick<TaskEngine, "runCollaborationProvider">;
  workerGeneration: string;
  contextVersion: number;
  contextHash: `sha256:${string}`;
  id(): string;
  now(): string;
  publish?(event: RoomEvent): void | Promise<void>;
}

function findingsAreValid(findings: string[]): boolean {
  return findings.length <= 100
    && findings.every((finding) => finding.length >= 1 && finding.length <= 2_000);
}

export class CollaborationCoordinator {
  private readonly inFlightRounds = new Map<string, {
    requestHash: string;
    promise: Promise<TaskRecord>;
  }>();

  constructor(private readonly options: CollaborationCoordinatorOptions) {}

  requestRound(input: RequestRoundInput): Promise<TaskRecord> {
    const requestHash = hashCanonical({
      taskId: input.taskId,
      purpose: input.purpose
    });
    const existing = this.inFlightRounds.get(input.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return Promise.reject(
          new Error(`ENGINE_IDEMPOTENCY_KEY_CONFLICT:${input.idempotencyKey}`)
        );
      }
      return existing.promise;
    }
    const request = this.requestRoundOnce(input);
    this.inFlightRounds.set(input.idempotencyKey, {
      requestHash,
      promise: request
    });
    void request.finally(() => {
      if (this.inFlightRounds.get(input.idempotencyKey)?.promise === request) {
        this.inFlightRounds.delete(input.idempotencyKey);
      }
    }).catch(() => undefined);
    return request;
  }

  async completeReview(input: {
    taskId: string;
    findings: string[];
    idempotencyKey: string;
  }): Promise<TaskRecord> {
    if (!findingsAreValid(input.findings)) throw new Error("REVIEW_FINDINGS_INVALID");
    const requestType = "collaboration.completeReview";
    const requestHash = hashCanonical({
      taskId: input.taskId,
      findings: input.findings
    });
    const tasks = this.options.repositories.tasks;
    const replay = tasks.replayCollaborationCompletion({
      taskId: input.taskId,
      idempotencyKey: input.idempotencyKey,
      requestType,
      requestHash
    });
    if (replay) return replay;
    const task = tasks.getRequired(input.taskId);
    const completedAt = this.options.now();
    const completion = tasks.completeCollaborationRound({
      taskId: task.id,
      round: task.collaborationRoundsUsed,
      idempotencyKey: input.idempotencyKey,
      requestType,
      requestHash,
      findingsHash: hashCanonical(input.findings),
      findings: input.findings,
      workerGeneration: this.options.workerGeneration,
      transition: task.state === "Review1"
        ? transitionTask(
            { ...task, updatedAt: completedAt },
            { type: "requestAgentRevision", findings: input.findings }
          )
        : null,
      transitionEventId: this.options.id(),
      eventId: this.options.id(),
      createdAt: completedAt
    });
    if (completion.event) await this.options.publish?.(completion.event);
    return completion.task;
  }

  private async requestRoundOnce(input: RequestRoundInput): Promise<TaskRecord> {
    const requestType = "collaboration.requestRound";
    const requestHash = hashCanonical({
      taskId: input.taskId,
      purpose: input.purpose
    });
    const tasks = this.options.repositories.tasks;
    const replay = tasks.replayEngineCommand(input.idempotencyKey, requestType, requestHash);
    if (replay) return replay;
    const task = tasks.getRequired(input.taskId);
    const receipt = this.approvedScope(task);
    if (!receipt.scope.allowCollaborator) throw new Error("COLLABORATOR_NOT_APPROVED");
    if (task.collaborationRoundsUsed >= task.collaborationRoundBudget) {
      throw new Error("COLLABORATION_ROUND_BUDGET_EXHAUSTED");
    }
    const lead = this.options.artifacts.getWorktree(task.id, "lead");
    if (!lead || lead.currentCheckpointOid === null) {
      throw new Error("LEAD_CHECKPOINT_REQUIRED");
    }
    const checkpoint = this.options.artifacts.listCheckpoints(task.id).find((candidate) =>
      candidate.worktreeId === lead.id && candidate.oid === lead.currentCheckpointOid
    );
    if (!checkpoint) throw new Error("LEAD_CHECKPOINT_RECORD_NOT_FOUND");
    await this.options.manager.verifyCheckpointRef({
      projectId: task.projectId,
      taskId: task.id,
      checkpoint
    });
    const project = this.options.repositories.projects.findById(task.projectId);
    if (!project) throw new Error(`PROJECT_NOT_FOUND:${task.projectId}`);
    const diff = await this.options.manager.getReadService().diff({
      repositoryRootRealpath: project.repositoryRoot,
      fromOid: task.baseOid,
      toOid: checkpoint.oid
    });
    const collaborator = await this.options.manager.ensureAgentWorktree({
      projectId: task.projectId,
      taskId: task.id,
      role: "collaborator",
      baseOid: task.baseOid,
      repositoryRootRealpath: project.repositoryRoot,
      commonDirRealpath: project.gitCommonDir,
      workerGeneration: this.options.workerGeneration,
      idempotencyKey: `${input.idempotencyKey}:worktree`
    });
    const reviewStartedAt = this.options.now();
    const started = tasks.startCollaborationRound({
      idempotencyKey: input.idempotencyKey,
      requestType,
      requestHash,
      workerGeneration: this.options.workerGeneration,
      transition: transitionTask(
        { ...tasks.getRequired(task.id), updatedAt: reviewStartedAt },
        { type: "beginReview", checkpointOid: checkpoint.oid }
      ),
      purpose: input.purpose,
      checkpointOid: checkpoint.oid,
      diffSummary: {
        filesChanged: diff.files.length,
        files: diff.files.slice(0, 200)
      },
      transitionEventId: this.options.id(),
      reviewEventId: this.options.id(),
      createdAt: reviewStartedAt
    });
    await this.options.publish?.(started.event);
    await this.options.engine.runCollaborationProvider({
      taskId: started.task.id,
      checkpoint,
      collaborator,
      purpose: input.purpose,
      diffFiles: diff.files
    });
    const result = tasks.getRequired(task.id);
    tasks.completeEngineCommand(input.idempotencyKey, result, this.options.now());
    return result;
  }

  private approvedScope(
    task: TaskRecord
  ): Extract<ApprovalReceipt, { kind: "task_scope" }> {
    if (!task.scopeApprovalId) throw new Error("TASK_SCOPE_APPROVAL_REQUIRED");
    const receipt = this.options.repositories.approvals.getRequired(task.scopeApprovalId);
    if (receipt.kind !== "task_scope"
      || receipt.taskId !== task.id
      || receipt.decision !== "approved"
      || receipt.scopeHash !== hashCanonical(receipt.scope)
      || !receipt.survivesWorkerRestart) {
      throw new Error("TASK_SCOPE_APPROVAL_INVALID");
    }
    return receipt;
  }

}
