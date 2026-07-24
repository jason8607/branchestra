import type {
  AgentProvider,
  AgentRunRecord,
  ApprovalReceipt,
  CheckpointRecord,
  RoomEvent,
  TaskProviderEventSummary,
  TaskRecord,
  WorktreeRecord
} from "../../shared/contracts/domain";
import { ApprovedWorkspace, hashBytes } from "../approvals/approved-workspace";
import { hashCanonical } from "../approvals/canonical-json";
import type { GitArtifactRepository } from "../git/git-artifact-repository";
import type { GitManager } from "../git/git-manager";
import { WorkspacePathGuard } from "../git/workspace-path-guard";
import type { JournaledOperationRunner } from "../operations/journaled-operation-runner";
import type { EventStore } from "../storage/event-store";
import type { DomainRepositories } from "../storage/repositories";
import type {
  TaskProviderEvent,
  TaskProviderPort,
  TaskProviderRunHandle
} from "./provider-port";
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
    "ensureAgentWorktree" | "createCheckpoint" | "getReadService" | "verifyCheckpointRef">;
  provider: TaskProviderPort;
  operations: JournaledOperationRunner;
  workerGeneration: string;
  contextVersion: number;
  contextHash: `sha256:${string}`;
  id(): string;
  now(): string;
  publish?(event: RoomEvent): void | Promise<void>;
}

function otherProvider(provider: AgentProvider): AgentProvider {
  return provider === "claude" ? "codex" : "claude";
}

function summarizeProviderEvent(event: TaskProviderEvent): TaskProviderEventSummary {
  if (event.type === "workspace.writeText") {
    return {
      type: event.type,
      relativePath: event.relativePath,
      contentHash: hashBytes(Buffer.from(event.contents, "utf8"))
    };
  }
  return event;
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
    const replay = tasks.replayEngineCommand(input.idempotencyKey, requestType, requestHash);
    if (replay) return replay;
    const task = tasks.getRequired(input.taskId);
    if (task.state !== "Review1" && task.state !== "Review2") {
      throw new Error(`TASK_NOT_IN_REVIEW:${task.state}`);
    }
    const started = [...this.options.events.after({
      roomId: task.roomId,
      roomSeq: 0,
      limit: 500
    }).events].reverse().find((event) =>
      event.type === "review.started"
      && event.payload.taskId === task.id
      && event.payload.round === task.collaborationRoundsUsed
    );
    if (!started || started.type !== "review.started") {
      throw new Error("DURABLE_REVIEW_CONTEXT_NOT_FOUND");
    }
    tasks.beginEngineCommand({
      idempotencyKey: input.idempotencyKey,
      requestType,
      requestHash,
      workerGeneration: this.options.workerGeneration,
      createdAt: this.options.now()
    });
    let result = task;
    if (task.state === "Review1") {
      result = tasks.applyTransition(
        transitionTask(
          { ...task, updatedAt: this.options.now() },
          { type: "requestAgentRevision", findings: input.findings }
        ),
        this.options.id()
      );
    }
    const event = this.options.events.append({
      id: this.options.id(),
      roomId: task.roomId,
      type: "review.completed",
      actor: "system",
      payload: {
        taskId: task.id,
        round: task.collaborationRoundsUsed,
        checkpointOid: started.payload.checkpointOid,
        findings: [...input.findings]
      },
      createdAt: this.options.now()
    });
    tasks.completeEngineCommand(input.idempotencyKey, result, this.options.now());
    await this.options.publish?.(event);
    return result;
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
    tasks.beginEngineCommand({
      idempotencyKey: input.idempotencyKey,
      requestType,
      requestHash,
      workerGeneration: this.options.workerGeneration,
      createdAt: this.options.now()
    });
    const reviewed = tasks.applyTransition(
      transitionTask(
        { ...tasks.getRequired(task.id), updatedAt: this.options.now() },
        { type: "beginReview", checkpointOid: checkpoint.oid }
      ),
      this.options.id()
    );
    const reviewEvent = this.options.events.append({
      id: this.options.id(),
      roomId: task.roomId,
      type: "review.started",
      actor: "system",
      payload: {
        taskId: task.id,
        round: reviewed.collaborationRoundsUsed,
        purpose: input.purpose,
        checkpointOid: checkpoint.oid,
        diffSummary: {
          filesChanged: diff.files.length,
          files: diff.files.slice(0, 200)
        }
      },
      createdAt: this.options.now()
    });
    await this.options.publish?.(reviewEvent);
    await this.runOtherProvider({
      task: reviewed,
      receipt,
      checkpoint,
      collaborator,
      purpose: input.purpose,
      diffFiles: diff.files
    });
    const result = tasks.getRequired(task.id);
    tasks.completeEngineCommand(input.idempotencyKey, result, this.options.now());
    return result;
  }

  private async runOtherProvider(input: {
    task: TaskRecord;
    receipt: Extract<ApprovalReceipt, { kind: "task_scope" }>;
    checkpoint: CheckpointRecord;
    collaborator: WorktreeRecord;
    purpose: RequestRoundInput["purpose"];
    diffFiles: Array<{ path: string; status: string; additions: number; deletions: number }>;
  }): Promise<void> {
    const provider = otherProvider(input.task.leadProvider);
    const role = input.purpose === "review" ? "reviewer" as const : "collaborator" as const;
    const run: AgentRunRecord = {
      id: this.options.id(),
      taskId: input.task.id,
      provider,
      role,
      providerSessionId: null,
      contextVersion: this.options.contextVersion,
      contextHash: this.options.contextHash,
      state: "starting",
      startedAt: this.options.now(),
      finishedAt: null
    };
    this.options.repositories.tasks.insertRun(run);
    let handle: TaskProviderRunHandle | null = null;
    try {
      handle = await this.options.provider.startRun({
        runId: run.id,
        taskId: input.task.id,
        provider,
        role,
        worktreePath: input.collaborator.pathRealpath,
        instruction: JSON.stringify({
          task: input.task.requestText,
          purpose: input.purpose,
          immutableLeadCheckpointOid: input.checkpoint.oid,
          roomContextHash: this.options.contextHash,
          readOnlyGit: { diffSummary: input.diffFiles }
        }),
        contextVersion: run.contextVersion,
        contextHash: run.contextHash,
        checkpointOid: input.checkpoint.oid,
        approvedCapabilities: {
          workspaceRootRealpath: input.collaborator.pathRealpath,
          readableRootsRealpath: [input.collaborator.pathRealpath],
          commandClasses: input.receipt.scope.commandClasses,
          toolNetwork: input.receipt.scope.toolNetwork,
          allowCollaborator: false,
          maxRunMs: input.receipt.scope.maxRunMs
        }
      });
      this.options.repositories.tasks.updateRunSession(run.id, handle.sessionId, "running");
      const workspace = input.purpose === "parallel_implementation"
        ? await this.collaboratorWorkspace(input.task, input.collaborator)
        : null;
      for await (const providerEvent of handle.events) {
        await this.recordProviderEvent(input.task, run, providerEvent);
        if (providerEvent.type === "workspace.writeText") {
          if (workspace === null) throw new Error("REVIEWER_WORKSPACE_MUTATION_FORBIDDEN");
          await workspace.writeText(providerEvent.relativePath, providerEvent.contents);
        }
      }
      const completion = await handle.completion;
      if (completion.outcome !== "completed") {
        throw new Error(completion.error?.code ?? "COLLABORATOR_RUN_FAILED");
      }
      this.options.repositories.tasks.updateRunState(run.id, "completed", this.options.now());
      if (input.purpose === "parallel_implementation") {
        const worktree = this.options.artifacts.getWorktree(input.task.id, "collaborator");
        if (!worktree) throw new Error("COLLABORATOR_WORKTREE_NOT_FOUND");
        const checkpoint = await this.options.manager.createCheckpoint({
          projectId: input.task.projectId,
          taskId: input.task.id,
          worktree,
          authorProvider: provider,
          purpose: "implementation",
          message: `Collaborator round ${input.task.collaborationRoundsUsed}`,
          checkpointId: this.options.id(),
          workerGeneration: this.options.workerGeneration,
          idempotencyKey: `${run.id}:checkpoint`
        });
        const event = this.options.events.append({
          id: this.options.id(),
          roomId: input.task.roomId,
          type: "checkpoint.created",
          actor: "system",
          payload: { checkpoint },
          createdAt: this.options.now()
        });
        await this.options.publish?.(event);
      }
    } catch (error) {
      this.options.repositories.tasks.updateRunState(run.id, "failed", this.options.now());
      if (handle) await this.options.provider.cancelRun(run.id, "user").catch(() => undefined);
      throw error;
    }
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

  private async collaboratorWorkspace(
    task: TaskRecord,
    worktree: WorktreeRecord
  ): Promise<ApprovedWorkspace> {
    const project = this.options.repositories.projects.findById(task.projectId);
    if (!project) throw new Error(`PROJECT_NOT_FOUND:${task.projectId}`);
    const guard = await WorkspacePathGuard.create({
      repositoryRootRealpath: project.repositoryRoot,
      worktreeRootRealpath: worktree.pathRealpath,
      gitCommonDirRealpath: project.gitCommonDir
    });
    return new ApprovedWorkspace(guard, this.options.operations, {
      projectId: task.projectId,
      taskId: task.id,
      commonDirRealpath: project.gitCommonDir,
      workerGeneration: this.options.workerGeneration,
      nextOperationId: this.options.id,
      now: this.options.now
    });
  }

  private async recordProviderEvent(
    task: TaskRecord,
    run: AgentRunRecord,
    providerEvent: TaskProviderEvent
  ): Promise<void> {
    const event = this.options.events.append({
      id: this.options.id(),
      roomId: task.roomId,
      type: "agent.run",
      actor: run.provider,
      payload: { run, event: summarizeProviderEvent(providerEvent) },
      createdAt: this.options.now()
    });
    await this.options.publish?.(event);
  }
}
