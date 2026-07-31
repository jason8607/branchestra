import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type {
  AgentProvider,
  ApprovalRequest,
  TaskCapabilityScope,
  TaskRecord
} from "../../shared/contracts/domain";
import {
  ApprovalRequestSchema,
  TaskRecordSchema
} from "../../shared/contracts/domain";
import { ApprovalService } from "../approvals/approval-service";
import { hashCanonical } from "../approvals/canonical-json";
import { NotFoundError } from "../domain/errors";
import { GitReadError, type GitReadService } from "../git/repository-inspector";
import type { EventStore } from "../storage/event-store";
import type {
  DurableResult,
  IdempotencyStore
} from "../storage/idempotency-store";
import type { DomainRepositories } from "../storage/repositories";
import { transitionTask } from "./task-state-machine";
import { parseAgentMentions } from "./mention-parser";

const COMMAND_CLASSES = ["build", "format", "lint", "test"] as const;
type CommandClass = typeof COMMAND_CLASSES[number];

export interface CreateTaskFromMessageInput {
  roomId: string;
  messageEventId: string;
  text: string;
  explicitLead: AgentProvider | null;
  idempotencyKey: string;
  commandClasses?: CommandClass[];
  allowCollaborator?: boolean;
  toolNetwork?: boolean;
  maxRunMs?: number;
  collaborationRoundBudget?: number;
}

export interface CreateTaskFromMessageResult {
  task: TaskRecord;
  approvalRequest: ApprovalRequest;
  baseSnapshotWarning: "main_worktree_dirty" | null;
}

const CreateTaskFromMessageResultSchema = z.object({
  task: TaskRecordSchema,
  approvalRequest: ApprovalRequestSchema,
  baseSnapshotWarning: z.literal("main_worktree_dirty").nullable()
}).strict() as z.ZodType<CreateTaskFromMessageResult>;

export interface TaskServiceDependencies {
  repositories: DomainRepositories;
  eventStore: EventStore;
  idempotencyStore: IdempotencyStore;
  gitReadService: Pick<GitReadService, "inspectRepository" | "status">;
  managedWorktreeRoot: string;
  workerGeneration: string;
  id(): string;
  now(): string;
}

function durableCommand(
  input: object,
  idempotencyKey: string,
  requestType: string,
  workerGeneration: string
) {
  return {
    idempotencyKey,
    requestType,
    requestHash: hashCanonical(input),
    workerGeneration
  };
}

function selectLead(
  text: string,
  explicitLead: AgentProvider | null
): AgentProvider {
  const mentions = parseAgentMentions(text);
  if (mentions.length === 0) throw new Error("AGENT_MENTION_REQUIRED");
  if (explicitLead !== null) {
    if (!mentions.includes(explicitLead)) throw new Error("LEAD_PROVIDER_NOT_MENTIONED");
    return explicitLead;
  }
  if (mentions.length !== 1) throw new Error("AMBIGUOUS_LEAD_PROVIDER");
  return mentions[0]!;
}

function scopeFromInput(
  input: CreateTaskFromMessageInput,
  identity: { rootRealpath: string; commonDirRealpath: string },
  writableRoot: string
): TaskCapabilityScope {
  const requestedClasses = input.commandClasses ?? [...COMMAND_CLASSES];
  const commandClasses = [...new Set(requestedClasses)].sort();
  if (commandClasses.some((item) => !(COMMAND_CLASSES as readonly string[]).includes(item))) {
    throw new Error("COMMAND_CLASS_INVALID");
  }
  const maxRunMs = input.maxRunMs ?? 120_000;
  if (!Number.isInteger(maxRunMs) || maxRunMs < 1 || maxRunMs > 3_600_000) {
    throw new Error("MAX_RUN_MS_INVALID");
  }
  const requestedBudget = input.collaborationRoundBudget ?? 2;
  const collaborationRoundBudget = Math.max(0, Math.min(2, Math.trunc(requestedBudget))) as 0 | 1 | 2;
  return {
    repositoryRootRealpath: identity.rootRealpath,
    gitCommonDirRealpath: identity.commonDirRealpath,
    writableRootsRealpath: [writableRoot],
    commandClasses,
    allowCollaborator: input.allowCollaborator ?? true,
    toolNetwork: input.toolNetwork ?? false,
    maxRunMs,
    collaborationRoundBudget
  };
}

export class TaskService {
  private readonly approvals: ApprovalService;

  constructor(private readonly dependencies: TaskServiceDependencies) {
    if (!isAbsolute(dependencies.managedWorktreeRoot)) {
      throw new Error("MANAGED_WORKTREE_ROOT_MUST_BE_ABSOLUTE");
    }
    this.approvals = new ApprovalService({
      approvals: dependencies.repositories.approvals,
      tasks: dependencies.repositories.tasks
    });
  }

  async createFromUserMessage(
    input: CreateTaskFromMessageInput
  ): Promise<CreateTaskFromMessageResult> {
    const metadata = durableCommand(
      input,
      `${input.idempotencyKey}:task`,
      "task.createFromUserMessage",
      this.dependencies.workerGeneration
    );
    const replayed = this.dependencies.idempotencyStore.replay(
      metadata,
      CreateTaskFromMessageResultSchema
    );
    if (replayed) return replayed.value;

    const leadProvider = selectLead(input.text, input.explicitLead);
    const room = this.dependencies.repositories.rooms.findById(input.roomId);
    if (!room) throw new NotFoundError(`Room not found: ${input.roomId}`);
    const project = this.dependencies.repositories.projects.findById(room.projectId);
    if (!project) throw new NotFoundError(`Project not found: ${room.projectId}`);
    const identity = await this.dependencies.gitReadService.inspectRepository(
      project.repositoryRoot,
      project.repositoryRoot
    );
    if (identity.commonDirRealpath !== project.gitCommonDir) {
      throw new GitReadError("REPOSITORY_IDENTITY_MISMATCH");
    }
    const status = await this.dependencies.gitReadService.status({
      repositoryRootRealpath: identity.rootRealpath,
      worktreePathRealpath: identity.rootRealpath
    });

    const taskId = this.dependencies.id();
    const approvalRequestId = this.dependencies.id();
    const createdAt = this.dependencies.now();
    const writableRoot = join(
      this.dependencies.managedWorktreeRoot,
      project.id,
      taskId,
      "lead"
    );
    const scope = scopeFromInput(input, identity, writableRoot);
    const task: TaskRecord = {
      id: taskId,
      roomId: room.id,
      projectId: project.id,
      requestEventId: input.messageEventId,
      requestText: input.text,
      leadProvider,
      targetRef: identity.headRef,
      baseOid: identity.headOid,
      state: "AwaitingApproval",
      interruptedFromState: null,
      collaborationRoundsUsed: 0,
      collaborationRoundBudget: scope.collaborationRoundBudget,
      humanRevisionCount: 0,
      revisionKind: null,
      scopeApprovalId: null,
      activeCandidateId: null,
      failure: null,
      version: 1,
      createdAt,
      updatedAt: createdAt
    };
    const approvalRequest: ApprovalRequest = {
      id: approvalRequestId,
      taskId,
      kind: "task_scope",
      scope,
      scopeHash: hashCanonical(scope),
      requestedGeneration: this.dependencies.workerGeneration,
      status: "pending",
      requestedAt: createdAt
    };
    const value = {
      task,
      approvalRequest,
      baseSnapshotWarning: status.clean ? null : "main_worktree_dirty" as const
    };
    const approvalRequestMetadata = durableCommand(
      { taskId, approvalRequest },
      `${input.idempotencyKey}:approval-request`,
      "task.createApprovalRequest",
      this.dependencies.workerGeneration
    );
    const timelineMetadata = durableCommand(
      { roomId: room.id, task, approvalRequest },
      `${input.idempotencyKey}:timeline`,
      "task.createTimeline",
      this.dependencies.workerGeneration
    );
    const TimelineResultSchema = z.object({
      taskCreatedEventId: z.string().min(1),
      approvalRequestedEventId: z.string().min(1)
    }).strict();

    return this.dependencies.idempotencyStore.execute(
      metadata,
      CreateTaskFromMessageResultSchema,
      () => {
        const currentRoom = this.dependencies.repositories.rooms.findById(input.roomId);
        const currentProject = currentRoom
          ? this.dependencies.repositories.projects.findById(currentRoom.projectId)
          : undefined;
        if (!currentRoom || !currentProject
          || currentRoom.id !== room.id
          || currentRoom.projectId !== project.id
          || currentProject.id !== project.id
          || currentProject.repositoryRoot !== project.repositoryRoot
          || currentProject.gitCommonDir !== project.gitCommonDir) {
          throw new Error("ROOM_PROJECT_CHANGED_DURING_INSPECTION");
        }
        this.dependencies.repositories.tasks.insert(task);
        this.dependencies.idempotencyStore.execute(
          approvalRequestMetadata,
          ApprovalRequestSchema,
          () => {
            this.dependencies.repositories.approvals.insertRequest(approvalRequest);
            return approvalRequest;
          }
        );
        this.dependencies.idempotencyStore.execute(
          timelineMetadata,
          TimelineResultSchema,
          () => {
            const taskCreated = this.dependencies.eventStore.append({
              id: this.dependencies.id(),
              roomId: room.id,
              type: "task.created",
              actor: "system",
              payload: { task },
              createdAt
            });
            const approvalRequested = this.dependencies.eventStore.append({
              id: this.dependencies.id(),
              roomId: room.id,
              type: "approval.requested",
              actor: "system",
              payload: { request: approvalRequest },
              createdAt
            });
            return {
              taskCreatedEventId: taskCreated.id,
              approvalRequestedEventId: approvalRequested.id
            };
          }
        );
        return value;
      }
    ).value;
  }

  async decideScope(input: {
    taskId: string;
    approvalRequestId: string;
    decision: "approved" | "rejected";
    displayedScopeHash: string;
    workerGeneration: string;
    idempotencyKey: string;
  }): Promise<TaskRecord> {
    return (await this.decideScopeResult(input)).value;
  }

  async decideScopeResult(input: {
    taskId: string;
    approvalRequestId: string;
    decision: "approved" | "rejected";
    displayedScopeHash: string;
    workerGeneration: string;
    idempotencyKey: string;
  }): Promise<DurableResult<TaskRecord>> {
    const metadata = durableCommand(
      input,
      input.idempotencyKey,
      "task.decideScope",
      input.workerGeneration
    );
    const replayed = this.dependencies.idempotencyStore.replay(metadata, TaskRecordSchema);
    if (replayed) return replayed;

    const displayedRequest = this.dependencies.repositories.approvals.getRequest(
      input.approvalRequestId
    );
    if (!displayedRequest || displayedRequest.taskId !== input.taskId
      || displayedRequest.kind !== "task_scope") {
      throw new Error("APPROVAL_REQUEST_NOT_FOUND");
    }
    const actualScopeHash = hashCanonical(displayedRequest.scope);
    if (displayedRequest.scopeHash !== actualScopeHash
      || input.displayedScopeHash !== actualScopeHash) {
      throw new Error("APPROVAL_SCOPE_HASH_MISMATCH");
    }
    if (displayedRequest.requestedGeneration !== input.workerGeneration) {
      throw new Error("APPROVAL_GENERATION_MISMATCH");
    }

    const receiptId = this.dependencies.id();
    const decidedAt = this.dependencies.now();
    return this.dependencies.idempotencyStore.execute(
      metadata,
      TaskRecordSchema,
      () => {
        const task = this.dependencies.repositories.tasks.getRequired(input.taskId);
        const request = this.dependencies.repositories.approvals.getRequest(
          input.approvalRequestId
        );
        if (!request || request.status !== "pending"
          || request.kind !== "task_scope"
          || request.taskId !== task.id
          || request.scopeHash !== actualScopeHash
          || hashCanonical(request.scope) !== actualScopeHash) {
          throw new Error("APPROVAL_REQUEST_CHANGED");
        }
        const receipt = this.approvals.createReceipt({
          id: receiptId,
          requestId: request.id,
          taskId: task.id,
          kind: "task_scope",
          decision: input.decision,
          scope: request.scope,
          workerGeneration: input.workerGeneration,
          decidedAt
        });
        this.dependencies.repositories.approvals.decideRequest(request.id, receipt);
        this.dependencies.eventStore.append({
          id: this.dependencies.id(),
          roomId: task.roomId,
          type: "approval.decided",
          actor: "system",
          payload: { receipt },
          createdAt: decidedAt
        });
        const transition = transitionTask(
          { ...task, updatedAt: decidedAt },
          input.decision === "approved"
            ? {
                type: "approveScope",
                receiptId,
                collaborationRoundBudget: request.scope.collaborationRoundBudget
              }
            : { type: "rejectScope", receiptId }
        );
        return this.dependencies.repositories.tasks.applyTransition(
          transition,
          this.dependencies.id()
        );
      }
    );
  }

  async grantAdditionalRounds(input: {
    taskId: string;
    approvalRequestId: string;
    additionalRounds: 1 | 2;
    displayedScopeHash: string;
    workerGeneration: string;
    idempotencyKey: string;
  }): Promise<TaskRecord> {
    return (await this.grantAdditionalRoundsResult(input)).value;
  }

  async grantAdditionalRoundsResult(input: {
    taskId: string;
    approvalRequestId: string;
    additionalRounds: 1 | 2;
    displayedScopeHash: string;
    workerGeneration: string;
    idempotencyKey: string;
  }): Promise<DurableResult<TaskRecord>> {
    const metadata = durableCommand(
      input,
      input.idempotencyKey,
      "task.grantAdditionalRounds",
      input.workerGeneration
    );
    const replayed = this.dependencies.idempotencyStore.replay(metadata, TaskRecordSchema);
    if (replayed) return replayed;

    const displayedRequest = this.dependencies.repositories.approvals.getRequest(
      input.approvalRequestId
    );
    if (!displayedRequest
      || displayedRequest.taskId !== input.taskId
      || displayedRequest.kind !== "additional_round"
      || displayedRequest.scope.additionalRounds !== input.additionalRounds) {
      throw new Error("ADDITIONAL_ROUND_REQUEST_NOT_FOUND");
    }
    const actualScopeHash = hashCanonical(displayedRequest.scope);
    if (displayedRequest.scopeHash !== actualScopeHash
      || input.displayedScopeHash !== actualScopeHash) {
      throw new Error("APPROVAL_SCOPE_HASH_MISMATCH");
    }
    if (displayedRequest.requestedGeneration !== input.workerGeneration) {
      throw new Error("APPROVAL_GENERATION_MISMATCH");
    }

    const receiptId = this.dependencies.id();
    const decidedAt = this.dependencies.now();
    return this.dependencies.idempotencyStore.execute(
      metadata,
      TaskRecordSchema,
      () => {
        const task = this.dependencies.repositories.tasks.getRequired(input.taskId);
        const request = this.dependencies.repositories.approvals.getRequest(
          input.approvalRequestId
        );
        if (!request
          || request.status !== "pending"
          || request.kind !== "additional_round"
          || request.taskId !== task.id
          || request.scope.additionalRounds !== input.additionalRounds
          || request.scopeHash !== actualScopeHash
          || hashCanonical(request.scope) !== actualScopeHash) {
          throw new Error("APPROVAL_REQUEST_CHANGED");
        }
        const receipt = this.approvals.createReceipt({
          id: receiptId,
          requestId: request.id,
          taskId: task.id,
          kind: "additional_round",
          decision: "approved",
          scope: request.scope,
          workerGeneration: input.workerGeneration,
          decidedAt
        });
        this.dependencies.repositories.approvals.decideRequest(request.id, receipt);
        this.dependencies.eventStore.append({
          id: this.dependencies.id(),
          roomId: task.roomId,
          type: "approval.decided",
          actor: "system",
          payload: { receipt },
          createdAt: decidedAt
        });
        return this.approvals.grantAdditionalRounds({
          task,
          receiptId,
          additionalRounds: input.additionalRounds,
          workerGeneration: input.workerGeneration,
          decidedAt,
          idempotencyKey: this.dependencies.id()
        });
      }
    );
  }

  requestRevision(input: {
    taskId: string;
    instruction: string;
    idempotencyKey: string;
  }): TaskRecord {
    if (input.instruction.trim().length === 0) throw new Error("REVISION_INSTRUCTION_REQUIRED");
    const task = this.dependencies.repositories.tasks.getRequired(input.taskId);
    return this.dependencies.repositories.tasks.applyTransition(
      transitionTask(
        { ...task, updatedAt: this.dependencies.now() },
        { type: "requestHumanRevision", instruction: input.instruction }
      ),
      this.dependencies.id()
    );
  }
}
