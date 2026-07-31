import { realpath } from "node:fs/promises";
import type {
  GitDiffFileSummary,
  IntegrationCandidate
} from "../../shared/contracts/domain";
import type { ApprovedCommandRunner } from "../approvals/approved-command-runner";
import type { ApprovalRepository } from "../approvals/approval-repository";
import { CandidateHasher } from "../git/candidate-hasher";
import type { GitArtifactRepository } from "../git/git-artifact-repository";
import type { GitCommandRunner } from "../git/git-command-runner";
import type { GitManager } from "../git/git-manager";
import { WorkspacePathGuard } from "../git/workspace-path-guard";
import type { EventStore } from "../storage/event-store";
import type { ProjectRepository } from "../storage/repositories";
import type { TaskRepository } from "./task-repository";
import { transitionTask } from "./task-state-machine";

interface CandidateServiceOptions {
  tasks: Pick<TaskRepository, "getRequired" | "applyTransition">;
  approvals: Pick<ApprovalRepository, "getRequired">;
  artifacts: GitArtifactRepository;
  projects: Pick<ProjectRepository, "findById">;
  manager: Pick<GitManager, "protectCandidate">;
  git: Pick<GitCommandRunner, "run" | "runBuffer">;
  commands: ApprovedCommandRunner;
  events: EventStore;
  id(): string;
  now(): string;
}

function parseCount(value: string): number {
  if (value === "-") return 0;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("CANDIDATE_NUMSTAT_INVALID");
  return parsed;
}

function parseNumstat(buffer: Buffer): GitDiffFileSummary[] {
  const records = buffer.toString("utf8").split("\0");
  const files: GitDiffFileSummary[] = [];
  for (let index = 0; index < records.length;) {
    const record = records[index++] ?? "";
    if (record === "") continue;
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 1 || secondTab < firstTab + 2) throw new Error("CANDIDATE_NUMSTAT_INVALID");
    const additions = parseCount(record.slice(0, firstTab));
    const deletions = parseCount(record.slice(firstTab + 1, secondTab));
    let path = record.slice(secondTab + 1);
    let status = "modified";
    if (path === "") {
      const oldPath = records[index++] ?? "";
      const newPath = records[index++] ?? "";
      if (oldPath === "" || newPath === "") throw new Error("CANDIDATE_NUMSTAT_RENAME_INVALID");
      path = newPath;
      status = "renamed";
    }
    files.push({ path, status, additions, deletions });
  }
  return files;
}

export class CandidateService {
  private readonly hasher = new CandidateHasher();

  constructor(private readonly options: CandidateServiceOptions) {}

  async buildVerifiedCandidate(input: {
    taskId: string;
    selectedCheckpointIds: string[];
    testCommandIds: string[];
    unresolved: IntegrationCandidate["unresolved"];
    workerGeneration: string;
    idempotencyKey: string;
  }): Promise<IntegrationCandidate> {
    if (new Set(input.selectedCheckpointIds).size !== input.selectedCheckpointIds.length) {
      throw new Error("CANDIDATE_CHECKPOINTS_DUPLICATED");
    }
    if (new Set(input.testCommandIds).size !== input.testCommandIds.length) {
      throw new Error("CANDIDATE_COMMANDS_DUPLICATED");
    }
    const task = this.options.tasks.getRequired(input.taskId);
    const project = this.options.projects.findById(task.projectId);
    if (!project) throw new Error(`PROJECT_NOT_FOUND:${task.projectId}`);
    const lead = this.options.artifacts.getWorktree(task.id, "lead");
    if (!lead) throw new Error("LEAD_WORKTREE_NOT_FOUND");
    const checkpoints = input.selectedCheckpointIds.map((checkpointId) => {
      const checkpoint = this.options.artifacts.getCheckpoint(checkpointId);
      if (!checkpoint) throw new Error(`CHECKPOINT_NOT_FOUND:${checkpointId}`);
      if (checkpoint.taskId !== task.id) throw new Error("CANDIDATE_CHECKPOINT_TASK_MISMATCH");
      return checkpoint;
    });
    void checkpoints;
    if (!task.scopeApprovalId) throw new Error("TASK_SCOPE_APPROVAL_REQUIRED");
    const receipt = this.options.approvals.getRequired(task.scopeApprovalId);
    const [repositoryRoot, commonDir, worktreePath] = await Promise.all([
      realpath(project.repositoryRoot),
      realpath(project.gitCommonDir),
      realpath(lead.pathRealpath)
    ]);
    const candidateId = this.options.id();
    const candidateOid = (await this.options.git.run(worktreePath, [
      "rev-parse", "--verify", "HEAD^{commit}"
    ])).stdout.trim();
    const guard = await WorkspacePathGuard.create({
      repositoryRootRealpath: repositoryRoot,
      worktreeRootRealpath: worktreePath,
      gitCommonDirRealpath: commonDir
    });
    for (const commandId of input.testCommandIds) {
      await this.options.commands.authorize({
        projectId: project.id,
        taskId: task.id,
        commandId,
        receipt,
        guard,
        workerGeneration: input.workerGeneration
      });
    }
    const protectedCandidate = await this.options.manager.protectCandidate({
      projectId: project.id,
      taskId: task.id,
      candidateId,
      leadWorktree: lead,
      expectedHeadOid: candidateOid,
      workerGeneration: input.workerGeneration,
      idempotencyKey: `${input.idempotencyKey}:candidate-ref`
    });
    const testResults = [];
    for (const commandId of input.testCommandIds) {
      testResults.push(await this.options.commands.run({
        projectId: project.id,
        taskId: task.id,
        candidateId,
        commandId,
        receipt,
        guard,
        commonDirRealpath: commonDir,
        workerGeneration: input.workerGeneration,
        idempotencyKey: `${input.idempotencyKey}:test:${commandId}`
      }));
    }
    const [diffBytes, numstatBytes] = await Promise.all([
      this.options.git.runBuffer(repositoryRoot, [
        "diff", "--binary", "--full-index", task.baseOid, protectedCandidate.candidateOid
      ]),
      this.options.git.runBuffer(repositoryRoot, [
        "diff", "--numstat", "-z", task.baseOid, protectedCandidate.candidateOid
      ])
    ]);
    const files = parseNumstat(numstatBytes);
    const candidate: IntegrationCandidate = {
      id: candidateId,
      taskId: task.id,
      leadWorktreeId: lead.id,
      targetRef: task.targetRef,
      baseOid: task.baseOid,
      candidateOid: protectedCandidate.candidateOid,
      immutableRef: protectedCandidate.immutableRef,
      diffHash: this.hasher.diffHash(diffBytes),
      testSetHash: this.hasher.testSetHash(testResults),
      diffSummary: {
        filesChanged: files.length,
        additions: files.reduce((total, file) => total + file.additions, 0),
        deletions: files.reduce((total, file) => total + file.deletions, 0),
        files
      },
      selectedCheckpointIds: [...input.selectedCheckpointIds],
      testResults,
      unresolved: input.unresolved.map((finding) => ({ ...finding })),
      verificationStatus: testResults.every(({ exitCode }) => exitCode === 0) ? "passed" : "failed",
      createdAt: this.options.now()
    };
    this.options.artifacts.persistCandidate(candidate);
    for (const result of testResults) {
      this.options.events.append({
        id: this.options.id(),
        roomId: task.roomId,
        type: "test.completed",
        actor: "system",
        payload: { result },
        createdAt: result.createdAt
      });
    }
    this.options.events.append({
      id: this.options.id(),
      roomId: task.roomId,
      type: "candidate.created",
      actor: "system",
      payload: { candidate },
      createdAt: candidate.createdAt
    });
    const candidateTask = this.options.tasks.applyTransition(
      transitionTask(
        { ...task, updatedAt: this.options.now() },
        { type: "candidateReady", candidateId }
      ),
      this.options.id()
    );
    this.options.tasks.applyTransition(
      transitionTask(
        { ...candidateTask, updatedAt: this.options.now() },
        { type: "requestHumanApproval" }
      ),
      this.options.id()
    );
    return candidate;
  }
}
