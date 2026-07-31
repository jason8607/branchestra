import type { FinalApprovalService } from "../approvals/final-approval-service";
import type { GitArtifactRepository } from "../git/git-artifact-repository";
import type { GitManager } from "../git/git-manager";
import type { E2EMockScenario } from "../providers/e2e-mock-scenarios";
import type { CollaborationCoordinator } from "./collaboration-coordinator";
import type { CandidateService } from "./candidate-service";
import type { TaskEngine } from "./task-engine";
import type { TaskRepository } from "./task-repository";

export class E2EMockWorkflow {
  constructor(private readonly options: {
    scenario: E2EMockScenario;
    engine: Pick<TaskEngine, "startApprovedTask">;
    collaboration: Pick<CollaborationCoordinator, "requestRound" | "completeReview">;
    candidates: Pick<CandidateService, "buildVerifiedCandidate">;
    finalApproval: Pick<FinalApprovalService, "request">;
    tasks: Pick<TaskRepository, "getRequired">;
    artifacts: Pick<GitArtifactRepository, "getWorktree" | "listCheckpoints">;
    manager: Pick<GitManager, "createCheckpoint">;
    workerGeneration: string;
    id(): string;
    invalidate(): void;
  }) {}

  async start(taskId: string, idempotencyKey: string): Promise<void> {
    try {
      await this.options.engine.startApprovedTask(taskId, `${idempotencyKey}:lead`);
      this.options.invalidate();
      if (this.options.scenario === "interrupted-run") return;

      await this.options.collaboration.requestRound({
        taskId,
        purpose: "review",
        idempotencyKey: `${idempotencyKey}:round-1`
      });
      await this.options.collaboration.completeReview({
        taskId,
        findings: ["Confirm shared greeting"],
        idempotencyKey: `${idempotencyKey}:review-1`
      });

      const task = this.options.tasks.getRequired(taskId);
      const lead = this.options.artifacts.getWorktree(taskId, "lead");
      if (!lead) throw new Error("LEAD_WORKTREE_NOT_FOUND");
      await this.options.manager.createCheckpoint({
        projectId: task.projectId,
        taskId,
        worktree: lead,
        authorProvider: task.leadProvider,
        purpose: "revision",
        message: "Address review",
        checkpointId: this.options.id(),
        workerGeneration: this.options.workerGeneration,
        idempotencyKey: `${idempotencyKey}:revision-checkpoint`
      });
      await this.options.collaboration.requestRound({
        taskId,
        purpose: "review",
        idempotencyKey: `${idempotencyKey}:round-2`
      });
      await this.options.collaboration.completeReview({
        taskId,
        findings: [],
        idempotencyKey: `${idempotencyKey}:review-2`
      });

      const checkpoint = this.options.artifacts.listCheckpoints(taskId)
        .filter(({ worktreeId }) => worktreeId === lead.id)
        .at(-1);
      if (!checkpoint) throw new Error("LEAD_CHECKPOINT_REQUIRED");
      await this.options.candidates.buildVerifiedCandidate({
        taskId,
        selectedCheckpointIds: [checkpoint.id],
        testCommandIds: ["unit"],
        unresolved: [],
        workerGeneration: this.options.workerGeneration,
        idempotencyKey: `${idempotencyKey}:candidate`
      });
      await this.options.finalApproval.request(taskId, `${idempotencyKey}:final-approval`);
    } finally {
      this.options.invalidate();
    }
  }
}
