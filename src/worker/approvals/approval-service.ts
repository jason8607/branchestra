import type {
  ApprovalReceipt,
  TaskCapabilityScope,
  TaskRecord
} from "../../shared/contracts/domain";
import type { ApprovalRepository } from "./approval-repository";
import type { TaskRepository } from "../tasks/task-repository";
import { transitionTask } from "../tasks/task-state-machine";
import { hashCanonical } from "./canonical-json";

type CreateReceiptInput = ApprovalReceipt extends infer TReceipt
  ? TReceipt extends ApprovalReceipt
    ? Omit<TReceipt, "scopeHash" | "survivesWorkerRestart">
    : never
  : never;

export interface ApprovalServiceDependencies {
  approvals: Pick<ApprovalRepository, "getRequired">;
  tasks?: Pick<TaskRepository, "applyTransition">;
}

export class ApprovalService {
  constructor(private readonly dependencies?: ApprovalServiceDependencies) {}

  createReceipt(input: CreateReceiptInput): ApprovalReceipt {
    return {
      ...input,
      scopeHash: hashCanonical(input.scope),
      survivesWorkerRestart: input.kind === "task_scope"
    } as ApprovalReceipt;
  }

  assertTaskCapability(
    receipt: ApprovalReceipt,
    currentGeneration: string
  ): TaskCapabilityScope {
    if (receipt.kind !== "task_scope") throw new Error("TASK_CAPABILITY_RECEIPT_REQUIRED");
    if (receipt.decision !== "approved") throw new Error("TASK_CAPABILITY_NOT_APPROVED");
    if (!receipt.survivesWorkerRestart) throw new Error("TASK_CAPABILITY_RECEIPT_INVALID");
    if (receipt.scopeHash !== hashCanonical(receipt.scope)) {
      throw new Error("TASK_CAPABILITY_SCOPE_MISMATCH");
    }
    void currentGeneration;
    return receipt.scope;
  }

  grantAdditionalRounds(input: {
    task: TaskRecord;
    receiptId: string;
    additionalRounds: 1 | 2;
    workerGeneration: string;
    decidedAt: string;
    idempotencyKey: string;
  }): TaskRecord {
    if (!this.dependencies) throw new Error("APPROVAL_SERVICE_REPOSITORIES_REQUIRED");
    const receipt = this.dependencies.approvals.getRequired(input.receiptId);
    if (receipt.kind !== "additional_round"
      || receipt.taskId !== input.task.id
      || receipt.decision !== "approved"
      || receipt.scope.additionalRounds !== input.additionalRounds) {
      throw new Error("ADDITIONAL_ROUND_NOT_APPROVED");
    }
    if (receipt.workerGeneration !== input.workerGeneration
      || receipt.survivesWorkerRestart
      || receipt.scopeHash !== hashCanonical(receipt.scope)) {
      throw new Error("ADDITIONAL_ROUND_RECEIPT_INVALID");
    }
    const transition = transitionTask(
      { ...input.task, updatedAt: input.decidedAt },
      {
        type: "grantAdditionalRounds",
        receiptId: receipt.id,
        additionalRounds: input.additionalRounds
      }
    );
    return this.dependencies.tasks
      ? this.dependencies.tasks.applyTransition(transition, input.idempotencyKey)
      : transition.next;
  }
}
