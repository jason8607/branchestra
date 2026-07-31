import type { TaskInspectorModel, TaskRecord } from "../../shared/contracts/domain";
import type { WorkerCommand } from "../../shared/contracts/protocol";
import type { ApprovalRepository } from "../approvals/approval-repository";
import type { FinalApprovalService } from "../approvals/final-approval-service";
import type { GitArtifactRepository } from "../git/git-artifact-repository";
import type { MergeService } from "../git/merge-service";
import type { AnyCommandHandler, CommandHandler } from "../protocol/command-handler";
import type { TaskEngine } from "./task-engine";
import type { RecoveryCoordinator } from "./recovery-coordinator";
import type { TaskRepository } from "./task-repository";
import type { TaskService } from "./task-service";

export class TaskInspectorQuery {
  constructor(private readonly options: {
    tasks: Pick<TaskRepository, "getRequired" | "listNonTerminal" | "listRuns">;
    approvals: Pick<ApprovalRepository, "get" | "getPendingRequest">;
    artifacts: Pick<GitArtifactRepository, "listWorktrees" | "listCheckpoints" | "getCandidate">;
    recovery: Pick<RecoveryCoordinator, "getPreview">;
  }) {}

  get(taskId: string): TaskInspectorModel {
    const task = this.options.tasks.getRequired(taskId);
    return this.model(task);
  }

  list(): TaskInspectorModel[] {
    return this.options.tasks.listNonTerminal().map((task) => this.model(task));
  }

  private model(task: TaskRecord): TaskInspectorModel {
    return {
      task,
      scopeReceipt: task.scopeApprovalId ? this.options.approvals.get(task.scopeApprovalId) : null,
      activeRuns: this.options.tasks.listRuns(task.id),
      worktrees: this.options.artifacts.listWorktrees(task.id),
      checkpoints: this.options.artifacts.listCheckpoints(task.id),
      candidate: task.activeCandidateId ? this.options.artifacts.getCandidate(task.activeCandidateId) : null,
      pendingApproval: this.options.approvals.getPendingRequest(task.id),
      recovery: this.options.recovery.getPreview(task.id)
    };
  }
}

export function createTaskCommandHandlers(deps: {
  workerGeneration: string;
  taskService: Pick<TaskService, "decideScope" | "grantAdditionalRounds" | "requestRevision">;
  taskEngine: Pick<TaskEngine, "startApprovedTask" | "cancel">;
  taskWorkflow?: { start(taskId: string, idempotencyKey: string): Promise<void> };
  finalApproval: Pick<FinalApprovalService, "approve">;
  merge: Pick<MergeService, "mergeApprovedCandidate">;
  recovery: Pick<RecoveryCoordinator, "preview" | "resolve">;
  inspector: Pick<TaskInspectorQuery, "get">;
}): readonly AnyCommandHandler[] {
  const guard = (contextGeneration: string): void => {
    if (contextGeneration !== deps.workerGeneration) throw new Error("WORKER_GENERATION_MISMATCH");
  };
  const handler = <TType extends WorkerCommand["type"]>(
    type: TType,
    handle: CommandHandler<TType>["handle"]
  ): CommandHandler<TType> => ({ type, handle });
  return [
    handler("task.get", (command, context) => {
      guard(context.workerGeneration);
      return { data: deps.inspector.get(command.payload.taskId), replayed: false };
    }),
    handler("task.approveScope", async (command, context) => {
      guard(context.workerGeneration);
      const task = await deps.taskService.decideScope({
        ...command.payload,
        workerGeneration: context.workerGeneration,
        idempotencyKey: context.idempotencyKey
      });
      if (command.payload.decision === "approved") {
        if (deps.taskWorkflow) {
          void deps.taskWorkflow.start(task.id, `${context.idempotencyKey}:start`).catch(() => undefined);
        } else {
          await deps.taskEngine.startApprovedTask(task.id, `${context.idempotencyKey}:start`);
        }
      }
      return { data: deps.inspector.get(task.id), replayed: false };
    }),
    handler("task.cancel", async (command, context) => {
      guard(context.workerGeneration);
      await deps.taskEngine.cancel(command.payload.taskId, command.payload.reason, context.idempotencyKey);
      return { data: deps.inspector.get(command.payload.taskId), replayed: false };
    }),
    handler("task.requestRevision", (command, context) => {
      guard(context.workerGeneration);
      deps.taskService.requestRevision({ ...command.payload, idempotencyKey: context.idempotencyKey });
      return { data: deps.inspector.get(command.payload.taskId), replayed: false };
    }),
    handler("task.grantAdditionalRound", async (command, context) => {
      guard(context.workerGeneration);
      await deps.taskService.grantAdditionalRounds({
        ...command.payload,
        workerGeneration: context.workerGeneration,
        idempotencyKey: context.idempotencyKey
      });
      return { data: deps.inspector.get(command.payload.taskId), replayed: false };
    }),
    handler("task.approveFinalMerge", async (command, context) => {
      guard(context.workerGeneration);
      const { taskId, approvalRequestId, ...displayed } = command.payload;
      const receipt = await deps.finalApproval.approve({
        taskId,
        approvalRequestId,
        displayed: {
          ...displayed,
          diffHash: displayed.diffHash as `sha256:${string}`,
          testSetHash: displayed.testSetHash as `sha256:${string}`
        },
        workerGeneration: context.workerGeneration,
        idempotencyKey: context.idempotencyKey
      });
      await deps.merge.mergeApprovedCandidate({
        taskId,
        approvalId: receipt.id,
        workerGeneration: context.workerGeneration,
        idempotencyKey: `${context.idempotencyKey}:merge`
      });
      return { data: deps.inspector.get(taskId), replayed: false };
    }),
    handler("task.recovery.preview", async (command, context) => {
      guard(context.workerGeneration);
      await deps.recovery.preview(command.payload.taskId);
      return { data: deps.inspector.get(command.payload.taskId), replayed: false };
    }),
    handler("task.recovery.resolve", async (command, context) => {
      guard(context.workerGeneration);
      await deps.recovery.resolve({
        ...command.payload,
        previewHash: command.payload.previewHash as `sha256:${string}`,
        idempotencyKey: context.idempotencyKey
      });
      return { data: deps.inspector.get(command.payload.taskId), replayed: false };
    })
  ] as readonly AnyCommandHandler[];
}
