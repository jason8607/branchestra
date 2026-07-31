import type { FinalApprovalService } from "../approvals/final-approval-service";
import type { EventStore } from "../storage/event-store";
import type { ProjectRepository } from "../storage/repositories";
import type { TaskRepository } from "../tasks/task-repository";
import { transitionTask } from "../tasks/task-state-machine";
import type { GitManager } from "./git-manager";
import type { GitReadService } from "./repository-inspector";

export type MergeOutcome = {
  outcome: "completed";
  mode: "checked_out_ff_only" | "unowned_update_ref_cas";
  targetRef: string;
  previousOid: string;
  targetOid: string;
};

interface MergeServiceOptions {
  finalApproval: Pick<FinalApprovalService, "assertCurrentlyValid" | "invalidate">;
  tasks: Pick<TaskRepository, "getRequired" | "applyTransition">;
  projects: Pick<ProjectRepository, "findById">;
  manager: Pick<GitManager, "fastForwardCheckedOutOwner" | "compareAndSwapUnownedRef">;
  readService: Pick<GitReadService, "listWorktrees">;
  events: EventStore;
  id(): string;
  now(): string;
}

export class MergeService {
  constructor(private readonly options: MergeServiceOptions) {}

  async mergeApprovedCandidate(input: {
    taskId: string;
    approvalId: string;
    workerGeneration: string;
    idempotencyKey: string;
  }): Promise<MergeOutcome> {
    const validated = await this.options.finalApproval.assertCurrentlyValid(
      input.approvalId,
      input.workerGeneration
    );
    if (validated.task.id !== input.taskId || validated.task.state !== "Merging") {
      throw new Error("MERGE_TASK_NOT_READY");
    }
    const project = this.options.projects.findById(validated.task.projectId);
    if (!project) throw new Error(`PROJECT_NOT_FOUND:${validated.task.projectId}`);
    const owners = (await this.options.readService.listWorktrees(project.repositoryRoot))
      .filter(({ branchRef }) => branchRef === validated.task.targetRef);
    if (owners.length > 1) {
      await this.options.finalApproval.invalidate(
        input.taskId,
        input.approvalId,
        "TARGET_REF_HAS_MULTIPLE_OWNERS",
        this.options.id()
      );
      throw new Error("TARGET_REF_HAS_MULTIPLE_OWNERS");
    }
    const assertApproved = async () => {
      await this.options.finalApproval.assertCurrentlyValid(input.approvalId, input.workerGeneration);
    };

    try {
      const mutation = owners[0]
        ? await this.options.manager.fastForwardCheckedOutOwner({
            projectId: project.id,
            taskId: validated.task.id,
            ownerWorktreeRealpath: owners[0].pathRealpath,
            targetRef: validated.task.targetRef,
            baseOid: validated.task.baseOid,
            candidateOid: validated.candidate.candidateOid,
            commonDirRealpath: project.gitCommonDir,
            workerGeneration: input.workerGeneration,
            idempotencyKey: `${input.idempotencyKey}:ff-only`,
            assertApproved
          })
        : await this.options.manager.compareAndSwapUnownedRef({
            projectId: project.id,
            taskId: validated.task.id,
            repositoryRootRealpath: project.repositoryRoot,
            targetRef: validated.task.targetRef,
            baseOid: validated.task.baseOid,
            candidateOid: validated.candidate.candidateOid,
            commonDirRealpath: project.gitCommonDir,
            workerGeneration: input.workerGeneration,
            idempotencyKey: `${input.idempotencyKey}:update-ref`,
            assertApproved
          });
      const outcome: MergeOutcome = {
        outcome: "completed",
        mode: mutation.mode,
        targetRef: validated.task.targetRef,
        previousOid: validated.task.baseOid,
        targetOid: mutation.targetOid
      };
      this.options.events.append({
        id: this.options.id(),
        roomId: validated.task.roomId,
        type: "merge.completed",
        actor: "system",
        payload: {
          taskId: validated.task.id,
          targetRef: outcome.targetRef,
          previousOid: outcome.previousOid,
          targetOid: outcome.targetOid,
          mode: outcome.mode
        },
        createdAt: this.options.now()
      });
      const current = this.options.tasks.getRequired(validated.task.id);
      this.options.tasks.applyTransition(
        transitionTask(
          { ...current, updatedAt: this.options.now() },
          { type: "mergeCompleted" }
        ),
        this.options.id()
      );
      return outcome;
    } catch (error) {
      const current = this.options.tasks.getRequired(input.taskId);
      if (current.state === "Merging") {
        await this.options.finalApproval.invalidate(
          input.taskId,
          input.approvalId,
          error instanceof Error ? error.message : "MERGE_FAILED",
          this.options.id()
        );
      }
      throw error;
    }
  }
}
