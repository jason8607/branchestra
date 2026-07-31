import type {
  ApprovalReceipt,
  ApprovalRequest,
  FinalApprovalTuple,
  IntegrationCandidate,
  TaskRecord
} from "../../shared/contracts/domain";
import { CandidateHasher } from "../git/candidate-hasher";
import type { GitArtifactRepository } from "../git/git-artifact-repository";
import type { GitCommandRunner } from "../git/git-command-runner";
import type { GitManager } from "../git/git-manager";
import type { EventStore } from "../storage/event-store";
import type { ProjectRepository } from "../storage/repositories";
import type { TaskRepository } from "../tasks/task-repository";
import { transitionTask } from "../tasks/task-state-machine";
import type { ApprovalRepository } from "./approval-repository";
import { hashCanonical } from "./canonical-json";

export interface FinalTupleSource {
  current(taskId: string): Promise<FinalApprovalTuple>;
}

interface FinalApprovalServiceOptions {
  tasks: Pick<TaskRepository, "getRequired" | "applyTransition">;
  approvals: Pick<ApprovalRepository,
    "insertRequest" | "getRequest" | "getPendingRequest" | "decideRequest" | "getRequired" | "listForTask">;
  events: EventStore;
  tupleSource: FinalTupleSource;
  candidates: { get(candidateId: string): IntegrationCandidate | null };
  workerGeneration: string;
  id(): string;
  now(): string;
}

const tupleFields = [
  ["targetRef", "TARGET_REF"],
  ["baseOid", "BASE_OID"],
  ["candidateOid", "CANDIDATE_OID"],
  ["diffHash", "DIFF_HASH"],
  ["testSetHash", "TEST_SET_HASH"]
] as const;

function assertTupleMatches(expected: FinalApprovalTuple, actual: FinalApprovalTuple): void {
  for (const [field, code] of tupleFields) {
    if (expected[field] !== actual[field]) throw new Error(`FINAL_APPROVAL_${code}_MISMATCH`);
  }
}

export class GitCandidateTupleSource implements FinalTupleSource {
  private readonly hasher = new CandidateHasher();

  constructor(private readonly options: {
    tasks: Pick<TaskRepository, "getRequired">;
    artifacts: Pick<GitArtifactRepository, "getCandidate">;
    projects: Pick<ProjectRepository, "findById">;
    manager: Pick<GitManager, "verifyCandidateRef">;
    git: Pick<GitCommandRunner, "runBuffer">;
  }) {}

  async current(taskId: string): Promise<FinalApprovalTuple> {
    const task = this.options.tasks.getRequired(taskId);
    if (!task.activeCandidateId) throw new Error("ACTIVE_CANDIDATE_REQUIRED");
    const candidate = this.options.artifacts.getCandidate(task.activeCandidateId);
    if (!candidate || candidate.taskId !== task.id) throw new Error("ACTIVE_CANDIDATE_NOT_FOUND");
    const project = this.options.projects.findById(task.projectId);
    if (!project) throw new Error(`PROJECT_NOT_FOUND:${task.projectId}`);
    await this.options.manager.verifyCandidateRef(
      project.repositoryRoot,
      candidate.immutableRef,
      candidate.candidateOid
    );
    const diff = await this.options.git.runBuffer(project.repositoryRoot, [
      "diff", "--binary", "--full-index", task.baseOid, candidate.candidateOid
    ]);
    return {
      targetRef: task.targetRef,
      baseOid: task.baseOid,
      candidateOid: candidate.candidateOid,
      diffHash: this.hasher.diffHash(diff),
      testSetHash: this.hasher.testSetHash(candidate.testResults)
    };
  }
}

export class FinalApprovalService {
  constructor(private readonly options: FinalApprovalServiceOptions) {}

  currentTuple(taskId: string): Promise<FinalApprovalTuple> {
    return this.options.tupleSource.current(taskId);
  }

  async request(taskId: string, idempotencyKey: string): Promise<ApprovalRequest> {
    void idempotencyKey;
    const task = this.options.tasks.getRequired(taskId);
    if (task.state !== "HumanApproval") throw new Error("FINAL_APPROVAL_TASK_NOT_READY");
    const scope = await this.currentTuple(taskId);
    const existing = this.options.approvals.getPendingRequest(taskId);
    if (existing?.kind === "final_merge") {
      assertTupleMatches(existing.scope, scope);
      return existing;
    }
    if (existing !== null) throw new Error("OTHER_APPROVAL_REQUEST_PENDING");
    const request: ApprovalRequest = {
      id: this.options.id(),
      taskId,
      kind: "final_merge",
      scope,
      scopeHash: hashCanonical(scope),
      requestedGeneration: this.options.workerGeneration,
      status: "pending",
      requestedAt: this.options.now()
    };
    this.options.approvals.insertRequest(request);
    this.options.events.append({
      id: this.options.id(),
      roomId: task.roomId,
      type: "approval.requested",
      actor: "system",
      payload: { request },
      createdAt: request.requestedAt
    });
    return request;
  }

  async approve(input: {
    taskId: string;
    approvalRequestId: string;
    displayed: FinalApprovalTuple;
    workerGeneration: string;
    idempotencyKey: string;
  }): Promise<ApprovalReceipt> {
    const task = this.options.tasks.getRequired(input.taskId);
    const request = this.options.approvals.getRequest(input.approvalRequestId);
    if (!request || request.taskId !== task.id || request.kind !== "final_merge") {
      throw new Error("FINAL_APPROVAL_REQUEST_MISMATCH");
    }
    const current = await this.currentTuple(task.id);
    assertTupleMatches(input.displayed, current);
    assertTupleMatches(request.scope, current);
    if (request.scopeHash !== hashCanonical(request.scope)) throw new Error("FINAL_APPROVAL_REQUEST_HASH_MISMATCH");
    if (request.requestedGeneration !== input.workerGeneration
      || input.workerGeneration !== this.options.workerGeneration) {
      throw new Error("FINAL_APPROVAL_GENERATION_MISMATCH");
    }
    if (request.status === "decided") {
      const replay = this.options.approvals.listForTask(task.id)
        .find((receipt) => receipt.requestId === request.id && receipt.kind === "final_merge");
      if (!replay || replay.kind !== "final_merge") throw new Error("FINAL_APPROVAL_RECEIPT_NOT_FOUND");
      if (replay.workerGeneration !== input.workerGeneration) throw new Error("FINAL_APPROVAL_GENERATION_MISMATCH");
      assertTupleMatches(replay.scope, current);
      return replay;
    }
    if (task.state !== "HumanApproval") throw new Error("FINAL_APPROVAL_TASK_NOT_READY");
    const receipt: ApprovalReceipt = {
      id: this.options.id(),
      requestId: request.id,
      taskId: task.id,
      kind: "final_merge",
      scope: current,
      decision: "approved",
      scopeHash: hashCanonical(current),
      workerGeneration: input.workerGeneration,
      survivesWorkerRestart: false,
      decidedAt: this.options.now()
    };
    this.options.approvals.decideRequest(request.id, receipt);
    this.options.events.append({
      id: this.options.id(),
      roomId: task.roomId,
      type: "approval.decided",
      actor: "system",
      payload: { receipt },
      createdAt: receipt.decidedAt
    });
    this.options.tasks.applyTransition(
      transitionTask(
        { ...task, updatedAt: this.options.now() },
        { type: "approveMerge", receiptId: receipt.id }
      ),
      this.options.id()
    );
    return receipt;
  }

  async assertCurrentlyValid(approvalId: string, workerGeneration: string): Promise<{
    task: TaskRecord;
    candidate: IntegrationCandidate;
    receipt: ApprovalReceipt;
  }> {
    const receipt = this.options.approvals.getRequired(approvalId);
    if (receipt.kind !== "final_merge" || receipt.decision !== "approved") {
      throw new Error("FINAL_APPROVAL_RECEIPT_REQUIRED");
    }
    const task = this.options.tasks.getRequired(receipt.taskId);
    if (receipt.workerGeneration !== workerGeneration || receipt.survivesWorkerRestart) {
      await this.invalidate(task.id, receipt.id, "FINAL_APPROVAL_GENERATION_MISMATCH", this.options.id());
      throw new Error("FINAL_APPROVAL_GENERATION_MISMATCH");
    }
    if (receipt.scopeHash !== hashCanonical(receipt.scope)) {
      await this.invalidate(task.id, receipt.id, "FINAL_APPROVAL_RECEIPT_HASH_MISMATCH", this.options.id());
      throw new Error("FINAL_APPROVAL_RECEIPT_HASH_MISMATCH");
    }
    const current = await this.currentTuple(task.id);
    try {
      assertTupleMatches(receipt.scope, current);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "FINAL_APPROVAL_TUPLE_MISMATCH";
      await this.invalidate(task.id, receipt.id, reason, this.options.id());
      throw error;
    }
    if (!task.activeCandidateId) throw new Error("ACTIVE_CANDIDATE_REQUIRED");
    const candidate = this.options.candidates.get(task.activeCandidateId);
    if (!candidate || candidate.taskId !== task.id || candidate.candidateOid !== current.candidateOid) {
      await this.invalidate(task.id, receipt.id, "FINAL_APPROVAL_CANDIDATE_OID_MISMATCH", this.options.id());
      throw new Error("FINAL_APPROVAL_CANDIDATE_OID_MISMATCH");
    }
    return { task, candidate, receipt };
  }

  async invalidate(taskId: string, approvalId: string, reason: string, idempotencyKey: string): Promise<TaskRecord> {
    void approvalId;
    void idempotencyKey;
    const task = this.options.tasks.getRequired(taskId);
    if (task.state !== "Merging" && task.state !== "HumanApproval") return task;
    return this.options.tasks.applyTransition(
      transitionTask(
        { ...task, updatedAt: this.options.now() },
        { type: "approvalInvalidated", reason }
      ),
      this.options.id()
    );
  }
}
