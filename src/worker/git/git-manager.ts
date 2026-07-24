import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type {
  AgentProvider,
  CheckpointRecord,
  Project,
  TaskRecord,
  WorktreeRecord
} from "../../shared/contracts/domain";
import type { ProjectRepository } from "../storage/repositories";
import type { TaskRepository } from "../tasks/task-repository";
import type { JournaledOperationRunner } from "../operations/journaled-operation-runner";
import type { OperationIntentRecord, OperationJournal } from "../operations/operation-journal";
import type { RepositoryLock } from "../operations/repository-lock";
import type { GitArtifactRepository } from "./git-artifact-repository";
import type { GitCommandRunner } from "./git-command-runner";
import { assertGitOid } from "./git-validation";
import { GitReadService } from "./repository-inspector";
import { WorkspacePathGuard } from "./workspace-path-guard";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CHECKPOINT_REF_PREFIX = "refs/branchestra/checkpoints/";
const APP_AUTHOR_NAME = "Branchestra";
const APP_AUTHOR_EMAIL = "branchestra@localhost";

export interface EnsureAgentWorktreeInput {
  projectId: string;
  taskId: string;
  role: "lead" | "collaborator";
  baseOid: string;
  repositoryRootRealpath: string;
  commonDirRealpath: string;
  workerGeneration: string;
  idempotencyKey: string;
}

export interface CreateCheckpointInput {
  projectId: string;
  taskId: string;
  worktree: WorktreeRecord;
  authorProvider: AgentProvider;
  purpose: CheckpointRecord["purpose"];
  message: string;
  checkpointId: string;
  workerGeneration: string;
  idempotencyKey: string;
}

export type IntegrateCheckpointResult =
  | { outcome: "integrated"; sourceOids: string[]; headOid: string }
  | {
      outcome: "conflict";
      sourceOids: string[];
      files: string[];
      headOidBefore: string;
    };

export interface IntegrateCheckpointInput {
  projectId: string;
  taskId: string;
  leadWorktree: WorktreeRecord;
  checkpoints: CheckpointRecord[];
  workerGeneration: string;
  idempotencyKey: string;
}

export interface GitManagerOptions {
  git: Pick<GitCommandRunner, "run" | "runBuffer">;
  readService?: GitReadService;
  artifacts: GitArtifactRepository;
  projects: Pick<ProjectRepository, "findById">;
  tasks: Pick<TaskRepository, "getRequired" | "listRuns">;
  lock: RepositoryLock;
  operations: JournaledOperationRunner;
  journal: Pick<OperationJournal, "getByIdempotencyKey">;
  managedWorktreeRoot: string;
  id(): string;
  now(): string;
}

interface WorktreeObservation extends Record<string, unknown> {
  branchOid: string | null;
  targetExists: boolean;
  matchingPath: string | null;
  matchingBranchRef: string | null;
  matchingHeadOid: string | null;
  repositoryCommonDirRealpath: string | null;
  executionError: string | null;
}

interface CommitObservation extends Record<string, unknown> {
  headOid: string | null;
  finalHeadOid: string | null;
  observedOid: string | null;
  branchRef: string | null;
  parentOid: string | null;
  trailer: string | null;
  indexTreeOid: string | null;
  commitTreeOid: string | null;
  authorName: string | null;
  authorEmail: string | null;
  executionError: string | null;
}

interface RefObservation extends Record<string, unknown> {
  refOid: string | null;
  executionError: string | null;
}

interface CommitResult {
  oid: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}:${error.message}` : String(error);
}

function isContained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function assertManagedParentSafe(managedRoot: string, targetParent: string): Promise<void> {
  if (!isContained(managedRoot, targetParent)) throw new Error("WORKTREE_PATH_ESCAPES_MANAGED_ROOT");
  const components = relative(managedRoot, targetParent).split(sep).filter(Boolean);
  let current = managedRoot;
  for (const component of components) {
    current = join(current, component);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) throw new Error("WORKTREE_PATH_SYMLINK_COMPONENT");
      if (!stats.isDirectory()) throw new Error("WORKTREE_PATH_COMPONENT_NOT_DIRECTORY");
      const currentRealpath = await realpath(current);
      if (!isContained(managedRoot, currentRealpath)) {
        throw new Error("WORKTREE_PATH_ESCAPES_MANAGED_ROOT");
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }
}

function assertSafeId(value: string, code: string): void {
  if (!SAFE_ID.test(value)) throw new Error(code);
}

function assertMessage(message: string): void {
  if (message.length < 1 || message.length > 4_000 || message.includes("\0")) {
    throw new Error("CHECKPOINT_MESSAGE_INVALID");
  }
  if (/^Branchestra-Checkpoint-Id\s*:/im.test(message)) {
    throw new Error("CHECKPOINT_MESSAGE_RESERVED_TRAILER");
  }
}

function sameWorktreeIdentity(actual: WorktreeRecord, supplied: WorktreeRecord): boolean {
  return actual.id === supplied.id
    && actual.taskId === supplied.taskId
    && actual.role === supplied.role
    && actual.pathRealpath === supplied.pathRealpath
    && actual.branchRef === supplied.branchRef
    && actual.baseOid === supplied.baseOid;
}

export class GitManager {
  private readonly readService: GitReadService;

  constructor(private readonly options: GitManagerOptions) {
    this.readService = options.readService ?? new GitReadService(options.git);
  }

  getReadService(): GitReadService {
    return this.readService;
  }

  async ensureAgentWorktree(input: EnsureAgentWorktreeInput): Promise<WorktreeRecord> {
    assertSafeId(input.projectId, "PROJECT_ID_INVALID");
    assertSafeId(input.taskId, "TASK_ID_INVALID");
    assertGitOid(input.baseOid);
    const { project, task, repositoryRoot, commonDir } = await this.resolveTaskRepository(input);
    const managedRoot = await realpath(this.options.managedWorktreeRoot);
    const targetPath = join(managedRoot, input.projectId, input.taskId, input.role);
    if (!isContained(managedRoot, targetPath)) throw new Error("WORKTREE_PATH_ESCAPES_MANAGED_ROOT");
    const branchRef = `refs/heads/branchestra/${input.taskId}/${input.role}`;
    const shortBranch = branchRef.slice("refs/heads/".length);
    let existingRecord = this.options.artifacts.getWorktree(input.taskId, input.role);
    if (existingRecord !== null
      && (existingRecord.branchRef !== branchRef
        || existingRecord.pathRealpath !== targetPath
        || existingRecord.baseOid !== input.baseOid)) {
      throw new Error("RECORDED_WORKTREE_IDENTITY_CONFLICT");
    }
    let expectedOid = existingRecord?.currentCheckpointOid ?? input.baseOid;
    assertGitOid(expectedOid);

    return this.options.lock.withLock(commonDir, async () => {
      const lockedRecord = this.options.artifacts.getWorktree(input.taskId, input.role);
      if (lockedRecord !== null) {
        if (lockedRecord.branchRef !== branchRef
          || lockedRecord.pathRealpath !== targetPath
          || lockedRecord.baseOid !== input.baseOid) {
          throw new Error("RECORDED_WORKTREE_IDENTITY_CONFLICT");
        }
        existingRecord = lockedRecord;
        expectedOid = lockedRecord.currentCheckpointOid ?? input.baseOid;
      }
      let action: "create" | "attach" | "noop" | "conflict" = "conflict";
      let executionError: string | null = null;
      const before = await this.observeWorktree(repositoryRoot, commonDir, targetPath, branchRef, null);
      if (before.branchOid === null && !before.targetExists && before.matchingPath === null) {
        action = "create";
      } else if (before.branchOid === input.baseOid && !before.targetExists && before.matchingPath === null) {
        action = "attach";
      } else if (this.isExpectedWorktree(before, expectedOid, targetPath, branchRef, commonDir)) {
        action = "noop";
      }
      const priorOperation = this.options.journal.getByIdempotencyKey(input.idempotencyKey);
      if (priorOperation?.status === "completed" && action !== "noop") {
        throw new Error(`COMPLETED_OPERATION_REQUIRES_RECONCILIATION:${priorOperation.id}`);
      }

      const createdAt = this.options.now();
      const intent: OperationIntentRecord<{
        branchRef: string;
        path: string;
        baseOid: string;
      }> = {
        id: this.options.id(),
        projectId: project.id,
        taskId: task.id,
        repositoryCommonDirRealpath: commonDir,
        operationType: "worktree.ensure",
        idempotencyKey: input.idempotencyKey,
        expected: { branchRef, path: targetPath, baseOid: input.baseOid },
        status: "intent",
        observation: null,
        workerGeneration: input.workerGeneration,
        createdAt,
        updatedAt: createdAt
      };

      let result: WorktreeRecord;
      try {
        result = await this.options.operations.run({
          intent,
          execute: async () => {
            if (action === "noop" || action === "conflict") return;
            try {
              await assertManagedParentSafe(managedRoot, dirname(targetPath));
              await mkdir(dirname(targetPath), { recursive: true });
              const parentRealpath = await realpath(dirname(targetPath));
              if (!isContained(managedRoot, parentRealpath) || await pathExists(targetPath)) {
                executionError = "WORKTREE_PATH_PRECONDITION_CHANGED";
                return;
              }
              if (action === "create") {
                await this.options.git.run(repositoryRoot, [
                  "worktree", "add", "-b", shortBranch, targetPath, input.baseOid
                ]);
              } else {
                await this.options.git.run(repositoryRoot, [
                  "worktree", "add", targetPath, shortBranch
                ]);
              }
            } catch (error) {
              executionError = errorMessage(error);
            }
          },
          observe: async () => {
            let actual: WorktreeObservation;
            try {
              actual = await this.observeWorktree(
                repositoryRoot,
                commonDir,
                targetPath,
                branchRef,
                executionError
              );
            } catch (error) {
              actual = {
                branchOid: null,
                targetExists: await pathExists(targetPath),
                matchingPath: null,
                matchingBranchRef: null,
                matchingHeadOid: null,
                repositoryCommonDirRealpath: null,
                executionError: executionError ?? errorMessage(error)
              };
              return { outcome: "uncertain" as const, actual };
            }
            if (!this.isExpectedWorktree(actual, expectedOid, targetPath, branchRef, commonDir)) {
              return { outcome: "conflict" as const, actual };
            }
            const record: WorktreeRecord = existingRecord ?? {
              id: this.options.id(),
              taskId: input.taskId,
              role: input.role,
              pathRealpath: targetPath,
              branchRef,
              baseOid: input.baseOid,
              currentCheckpointOid: null,
              retained: true,
              createdAt: this.options.now()
            };
            return { outcome: "applied" as const, actual, result: record };
          }
        });
      } catch (error) {
        if (action === "conflict") throw new Error("WORKTREE_STATE_CONFLICT", { cause: error });
        throw error;
      }

      const persisted = this.options.artifacts.getWorktree(input.taskId, input.role);
      if (persisted === null) {
        this.options.artifacts.insertWorktree(result);
        return result;
      }
      if (!sameWorktreeIdentity(persisted, result)) throw new Error("RECORDED_WORKTREE_IDENTITY_CONFLICT");
      return persisted;
    });
  }

  async createCheckpoint(input: CreateCheckpointInput): Promise<CheckpointRecord> {
    assertSafeId(input.projectId, "PROJECT_ID_INVALID");
    assertSafeId(input.taskId, "TASK_ID_INVALID");
    assertSafeId(input.checkpointId, "CHECKPOINT_ID_INVALID");
    assertMessage(input.message);
    if (input.authorProvider !== "claude" && input.authorProvider !== "codex") {
      throw new Error("CHECKPOINT_AUTHOR_PROVIDER_INVALID");
    }
    const task = this.options.tasks.getRequired(input.taskId);
    if (task.projectId !== input.projectId) throw new Error("TASK_PROJECT_MISMATCH");
    const project = this.options.projects.findById(input.projectId);
    if (!project) throw new Error(`PROJECT_NOT_FOUND:${input.projectId}`);
    const storedWorktree = this.options.artifacts.getWorktree(input.taskId, input.worktree.role);
    if (!storedWorktree || !sameWorktreeIdentity(storedWorktree, input.worktree)) {
      throw new Error("WORKTREE_RECORD_MISMATCH");
    }
    if (this.options.tasks.listRuns(input.taskId).some((run) =>
      run.role === input.worktree.role && (run.state === "starting" || run.state === "running"))) {
      throw new Error("AGENT_STILL_WRITING");
    }
    const repositoryRoot = await realpath(project.repositoryRoot);
    const commonDir = await realpath(project.gitCommonDir);
    const identity = await this.readService.inspectRepository(repositoryRoot, repositoryRoot);
    if (identity.commonDirRealpath !== commonDir) throw new Error("REPOSITORY_IDENTITY_MISMATCH");
    const worktreePath = await realpath(storedWorktree.pathRealpath);
    if (worktreePath !== storedWorktree.pathRealpath) throw new Error("WORKTREE_REALPATH_MISMATCH");
    const guard = await WorkspacePathGuard.create({
      repositoryRootRealpath: repositoryRoot,
      worktreeRootRealpath: worktreePath,
      gitCommonDirRealpath: commonDir
    });
    await guard.assertChildCwd(worktreePath);

    return this.options.lock.withLock(commonDir, async () => {
      const refName = `${CHECKPOINT_REF_PREFIX}${input.checkpointId}`;
      const commitKey = `${input.idempotencyKey}:commit`;
      const refKey = `${input.idempotencyKey}:ref`;
      const priorCommit = this.options.journal.getByIdempotencyKey(commitKey);
      const priorParent = priorCommit?.expected
        && typeof priorCommit.expected === "object"
        && "parentOid" in priorCommit.expected
        && typeof priorCommit.expected.parentOid === "string"
        ? priorCommit.expected.parentOid
        : null;
      const expectedParent = priorParent ?? storedWorktree.currentCheckpointOid ?? storedWorktree.baseOid;
      assertGitOid(expectedParent);

      const existingCheckpoint = this.options.artifacts.getCheckpoint(input.checkpointId);
      if (existingCheckpoint !== null) {
        const priorRef = this.options.journal.getByIdempotencyKey(refKey);
        if (priorRef?.status !== "completed" || priorCommit?.status !== "completed") {
          throw new Error("IMMUTABLE_CHECKPOINT_REF_CONFLICT");
        }
        const expected = priorCommit.expected;
        if (typeof expected !== "object"
          || expected === null
          || expected.worktreeId !== storedWorktree.id
          || expected.checkpointId !== input.checkpointId
          || expected.branchRef !== storedWorktree.branchRef
          || expected.message !== input.message
          || expected.authorProvider !== input.authorProvider
          || expected.purpose !== input.purpose) {
          throw new Error("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INTENT");
        }
        const refOid = await this.resolveRef(repositoryRoot, refName);
        if (refOid !== existingCheckpoint.oid) throw new Error("IMMUTABLE_CHECKPOINT_REF_CONFLICT");
        return existingCheckpoint;
      }
      const preexistingRef = await this.resolveRef(repositoryRoot, refName);
      if (preexistingRef !== null && priorCommit === null) {
        throw new Error("IMMUTABLE_CHECKPOINT_REF_CONFLICT");
      }

      let commitError: string | null = null;
      const commitCreatedAt = this.options.now();
      const commitIntent: OperationIntentRecord<{
        worktreeId: string;
        checkpointId: string;
        parentOid: string;
        branchRef: string;
        message: string;
        authorProvider: AgentProvider;
        purpose: CheckpointRecord["purpose"];
      }> = {
        id: this.options.id(),
        projectId: project.id,
        taskId: task.id,
        repositoryCommonDirRealpath: commonDir,
        operationType: "checkpoint.commit",
        idempotencyKey: commitKey,
        expected: {
          worktreeId: storedWorktree.id,
          checkpointId: input.checkpointId,
          parentOid: expectedParent,
          branchRef: storedWorktree.branchRef,
          message: input.message,
          authorProvider: input.authorProvider,
          purpose: input.purpose
        },
        status: "intent",
        observation: null,
        workerGeneration: input.workerGeneration,
        createdAt: commitCreatedAt,
        updatedAt: commitCreatedAt
      };
      let commit: CommitResult;
      try {
        commit = await this.options.operations.run({
          intent: commitIntent,
          execute: async () => {
            try {
              const [head, branch] = await Promise.all([
                this.resolveHead(worktreePath),
                this.resolveSymbolicHead(worktreePath)
              ]);
              if (head !== expectedParent || branch !== storedWorktree.branchRef) {
                commitError = "CHECKPOINT_HEAD_PRECONDITION_FAILED";
                return;
              }
              await this.options.git.run(worktreePath, ["add", "--all"]);
              await this.options.git.run(worktreePath, [
                "commit",
                "--allow-empty",
                "--no-gpg-sign",
                "-m", input.message,
                "--trailer", `Branchestra-Checkpoint-Id=${input.checkpointId}`
              ]);
            } catch (error) {
              commitError = errorMessage(error);
            }
          },
          observe: async () => {
            let actual: CommitObservation;
            try {
              actual = await this.observeCommit(
                worktreePath,
                input.checkpointId,
                commitError
              );
            } catch (error) {
              actual = {
                headOid: null,
                finalHeadOid: null,
                observedOid: null,
                branchRef: null,
                parentOid: null,
                trailer: null,
                indexTreeOid: null,
                commitTreeOid: null,
                authorName: null,
                authorEmail: null,
                executionError: commitError ?? errorMessage(error)
              };
              return { outcome: "uncertain" as const, actual };
            }
            if (actual.headOid === expectedParent) {
              return { outcome: "not_applied" as const, actual };
            }
            if (actual.parentOid !== expectedParent
              || actual.observedOid !== actual.headOid
              || actual.finalHeadOid !== actual.headOid
              || actual.branchRef !== storedWorktree.branchRef
              || actual.trailer !== input.checkpointId
              || actual.indexTreeOid !== actual.commitTreeOid
              || actual.authorName !== APP_AUTHOR_NAME
              || actual.authorEmail !== APP_AUTHOR_EMAIL
              || actual.headOid === null) {
              return { outcome: "conflict" as const, actual };
            }
            return {
              outcome: "applied" as const,
              actual,
              result: { oid: actual.headOid }
            };
          }
        });
      } catch (error) {
        throw new Error("CHECKPOINT_COMMIT_NEEDS_ATTENTION", { cause: error });
      }

      let refError: string | null = null;
      const checkpointCreatedAt = this.options.now();
      const checkpoint: CheckpointRecord = {
        id: input.checkpointId,
        taskId: input.taskId,
        worktreeId: storedWorktree.id,
        authorProvider: input.authorProvider,
        purpose: input.purpose,
        oid: commit.oid,
        immutableRef: refName,
        createdAt: checkpointCreatedAt
      };
      const refIntent: OperationIntentRecord<{
        checkpointId: string;
        ref: string;
        oid: string;
      }> = {
        id: this.options.id(),
        projectId: project.id,
        taskId: task.id,
        repositoryCommonDirRealpath: commonDir,
        operationType: "checkpoint.ref.create",
        idempotencyKey: refKey,
        expected: { checkpointId: input.checkpointId, ref: refName, oid: commit.oid },
        status: "intent",
        observation: null,
        workerGeneration: input.workerGeneration,
        createdAt: checkpointCreatedAt,
        updatedAt: checkpointCreatedAt
      };
      let result: CheckpointRecord;
      try {
        result = await this.options.operations.run({
          intent: refIntent,
          execute: async () => {
            try {
              const current = await this.resolveRef(repositoryRoot, refName);
              if (current === commit.oid) return;
              if (current !== null) {
                refError = "IMMUTABLE_CHECKPOINT_REF_CONFLICT";
                return;
              }
              await this.options.git.run(repositoryRoot, [
                "update-ref", refName, commit.oid, "0".repeat(commit.oid.length)
              ]);
            } catch (error) {
              refError = errorMessage(error);
            }
          },
          observe: async () => {
            const refOid = await this.resolveRef(repositoryRoot, refName);
            const actual: RefObservation = { refOid, executionError: refError };
            if (refOid === commit.oid) {
              return { outcome: "applied" as const, actual, result: checkpoint };
            }
            if (refOid === null) return { outcome: "not_applied" as const, actual };
            return { outcome: "conflict" as const, actual };
          }
        });
      } catch (error) {
        if (refError === "IMMUTABLE_CHECKPOINT_REF_CONFLICT") {
          throw new Error("IMMUTABLE_CHECKPOINT_REF_CONFLICT", { cause: error });
        }
        throw new Error("CHECKPOINT_REF_NEEDS_ATTENTION", { cause: error });
      }

      const persisted = this.options.artifacts.getCheckpoint(input.checkpointId);
      if (persisted === null) {
        this.options.artifacts.persistCheckpoint(result);
        return result;
      }
      if (persisted.oid !== result.oid || persisted.immutableRef !== result.immutableRef) {
        throw new Error("IMMUTABLE_CHECKPOINT_REF_CONFLICT");
      }
      return persisted;
    });
  }

  async verifyCheckpointRef(input: {
    projectId: string;
    taskId: string;
    checkpoint: CheckpointRecord;
  }): Promise<void> {
    const task = this.options.tasks.getRequired(input.taskId);
    if (task.projectId !== input.projectId) throw new Error("TASK_PROJECT_MISMATCH");
    if (input.checkpoint.taskId !== input.taskId) throw new Error("CHECKPOINT_TASK_MISMATCH");
    if (input.checkpoint.immutableRef
      !== `${CHECKPOINT_REF_PREFIX}${input.checkpoint.id}`) {
      throw new Error("CHECKPOINT_IMMUTABLE_REF_INVALID");
    }
    const project = this.options.projects.findById(input.projectId);
    if (!project) throw new Error(`PROJECT_NOT_FOUND:${input.projectId}`);
    const repositoryRoot = await realpath(project.repositoryRoot);
    const actual = await this.resolveRef(repositoryRoot, input.checkpoint.immutableRef);
    if (actual !== input.checkpoint.oid) {
      throw new Error("IMMUTABLE_CHECKPOINT_REF_CONFLICT");
    }
  }

  async integrateCheckpoint(
    input: IntegrateCheckpointInput
  ): Promise<IntegrateCheckpointResult> {
    assertSafeId(input.projectId, "PROJECT_ID_INVALID");
    assertSafeId(input.taskId, "TASK_ID_INVALID");
    if (input.checkpoints.length > 100) throw new Error("CHECKPOINT_SELECTION_TOO_LARGE");
    const task = this.options.tasks.getRequired(input.taskId);
    if (task.projectId !== input.projectId) throw new Error("TASK_PROJECT_MISMATCH");
    const project = this.options.projects.findById(input.projectId);
    if (!project) throw new Error(`PROJECT_NOT_FOUND:${input.projectId}`);
    const storedLead = this.options.artifacts.getWorktree(input.taskId, "lead");
    if (!storedLead
      || input.leadWorktree.role !== "lead"
      || !sameWorktreeIdentity(storedLead, input.leadWorktree)) {
      throw new Error("LEAD_WORKTREE_RECORD_MISMATCH");
    }
    const checkpointIds = new Set<string>();
    for (const checkpoint of input.checkpoints) {
      if (checkpointIds.has(checkpoint.id)) throw new Error("DUPLICATE_CHECKPOINT_SELECTION");
      checkpointIds.add(checkpoint.id);
      if (checkpoint.taskId !== input.taskId) throw new Error("CHECKPOINT_TASK_MISMATCH");
      if (checkpoint.immutableRef !== `${CHECKPOINT_REF_PREFIX}${checkpoint.id}`) {
        throw new Error("CHECKPOINT_IMMUTABLE_REF_INVALID");
      }
      assertGitOid(checkpoint.oid);
    }
    const [repositoryRoot, commonDir, worktreePath] = await Promise.all([
      realpath(project.repositoryRoot),
      realpath(project.gitCommonDir),
      realpath(storedLead.pathRealpath)
    ]);
    if (worktreePath !== storedLead.pathRealpath) {
      throw new Error("WORKTREE_REALPATH_MISMATCH");
    }
    const identity = await this.readService.inspectRepository(worktreePath, worktreePath);
    if (identity.commonDirRealpath !== commonDir) {
      throw new Error("REPOSITORY_IDENTITY_MISMATCH");
    }
    const guard = await WorkspacePathGuard.create({
      repositoryRootRealpath: repositoryRoot,
      worktreeRootRealpath: worktreePath,
      gitCommonDirRealpath: commonDir
    });
    await guard.assertChildCwd(worktreePath);

    return this.options.lock.withLock(commonDir, async () => {
      for (const checkpoint of input.checkpoints) {
        const refOid = await this.resolveRef(repositoryRoot, checkpoint.immutableRef);
        if (refOid !== checkpoint.oid) {
          throw new Error("IMMUTABLE_CHECKPOINT_REF_CONFLICT");
        }
      }
      const sourceOids = input.checkpoints.map(({ oid }) => oid);
      const priorOperation = this.options.journal.getByIdempotencyKey(
        input.idempotencyKey
      );
      if (priorOperation !== null
        && (priorOperation.operationType !== "checkpoint.integrate"
          || priorOperation.projectId !== input.projectId
          || priorOperation.taskId !== input.taskId)) {
        throw new Error("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INTENT");
      }
      let headAtStart: string;
      if (priorOperation === null) {
        const statusBefore = await this.readService.status({
          repositoryRootRealpath: repositoryRoot,
          worktreePathRealpath: worktreePath
        });
        if (!statusBefore.clean || statusBefore.inProgressOperation !== null) {
          throw new Error("LEAD_WORKTREE_NOT_CLEAN");
        }
        headAtStart = await this.resolveHead(worktreePath);
      } else {
        const expected = priorOperation.expected;
        if (typeof expected !== "object"
          || expected === null
          || !("headOidBefore" in expected)
          || typeof expected.headOidBefore !== "string") {
          throw new Error("RECORDED_INTEGRATION_INTENT_INVALID");
        }
        headAtStart = expected.headOidBefore;
        assertGitOid(headAtStart);
      }
      const createdAt = this.options.now();
      const intent: OperationIntentRecord<{
        leadWorktreeId: string;
        checkpointIds: string[];
        sourceOids: string[];
        headOidBefore: string;
      }> = {
        id: this.options.id(),
        projectId: input.projectId,
        taskId: input.taskId,
        repositoryCommonDirRealpath: commonDir,
        operationType: "checkpoint.integrate",
        idempotencyKey: input.idempotencyKey,
        expected: {
          leadWorktreeId: storedLead.id,
          checkpointIds: input.checkpoints.map(({ id }) => id),
          sourceOids,
          headOidBefore: headAtStart
        },
        status: "intent",
        observation: null,
        workerGeneration: input.workerGeneration,
        createdAt,
        updatedAt: createdAt
      };
      let result: IntegrateCheckpointResult | null = null;
      let executionError: string | null = null;
      try {
        result = await this.options.operations.run<
          typeof intent.expected,
          Record<string, unknown>,
          IntegrateCheckpointResult
        >({
          intent,
          execute: async () => {
            try {
              if (input.checkpoints.length === 0) {
                result = { outcome: "integrated", sourceOids, headOid: headAtStart };
                return;
              }
              for (const checkpoint of input.checkpoints) {
                const beforePick = await this.resolveHead(worktreePath);
                const beforeStatus = await this.readService.status({
                  repositoryRootRealpath: repositoryRoot,
                  worktreePathRealpath: worktreePath
                });
                if (!beforeStatus.clean || beforeStatus.inProgressOperation !== null) {
                  throw new Error("LEAD_WORKTREE_NOT_CLEAN");
                }
                try {
                  await this.options.git.run(worktreePath, [
                    "cherry-pick", "--no-gpg-sign", checkpoint.oid
                  ]);
                } catch (error) {
                  const conflictStatus = await this.readService.status({
                    repositoryRootRealpath: repositoryRoot,
                    worktreePathRealpath: worktreePath
                  });
                  if (conflictStatus.inProgressOperation !== "cherry-pick") throw error;
                  const cherryPickHead = await this.resolveRequiredRevision(
                    worktreePath,
                    "CHERRY_PICK_HEAD"
                  );
                  if (cherryPickHead !== checkpoint.oid) {
                    throw new Error("CHERRY_PICK_HEAD_MISMATCH", { cause: error });
                  }
                  const files = this.unmergedFiles(conflictStatus.entries);
                  if (files.length === 0) {
                    throw new Error("CHERRY_PICK_CONFLICT_FILES_MISSING", { cause: error });
                  }
                  result = {
                    outcome: "conflict",
                    sourceOids,
                    files,
                    headOidBefore: beforePick
                  };
                  return;
                }
                const afterPick = await this.resolveHead(worktreePath);
                if (afterPick === beforePick
                  || !await this.hasSingleParent(worktreePath, afterPick, beforePick)) {
                  throw new Error("CHERRY_PICK_PARENT_MISMATCH");
                }
              }
              const finalStatus = await this.readService.status({
                repositoryRootRealpath: repositoryRoot,
                worktreePathRealpath: worktreePath
              });
              if (!finalStatus.clean || finalStatus.inProgressOperation !== null) {
                throw new Error("INTEGRATED_WORKTREE_NOT_CLEAN");
              }
              result = {
                outcome: "integrated",
                sourceOids,
                headOid: await this.resolveHead(worktreePath)
              };
            } catch (error) {
              executionError = errorMessage(error);
            }
          },
          observe: async () => {
            if (result === null) {
              return {
                outcome: "uncertain" as const,
                actual: { executionError }
              };
            }
            if (result.outcome === "conflict") {
              const [headOid, cherryPickHead] = await Promise.all([
                this.resolveHead(worktreePath),
                this.resolveRequiredRevision(worktreePath, "CHERRY_PICK_HEAD")
              ]);
              if (headOid !== result.headOidBefore
                || !sourceOids.includes(cherryPickHead)
                || result.files.length === 0) {
                return {
                  outcome: "conflict" as const,
                  actual: { result, headOid, cherryPickHead, executionError }
                };
              }
            } else if (await this.resolveHead(worktreePath) !== result.headOid) {
              return {
                outcome: "conflict" as const,
                actual: {
                  result,
                  observedHeadOid: await this.resolveHead(worktreePath),
                  executionError
                }
              };
            }
            return {
              outcome: "applied" as const,
              actual: { result, executionError },
              result
            };
          }
        });
      } catch (error) {
        if (executionError !== null) {
          throw new Error("CHECKPOINT_INTEGRATION_NEEDS_ATTENTION", { cause: error });
        }
        throw error;
      }
      this.options.artifacts.updateCheckpoint(
        storedLead.id,
        result.outcome === "integrated" ? result.headOid : result.headOidBefore
      );
      return result;
    });
  }

  async continueIntegration(input: {
    projectId: string;
    taskId: string;
    leadWorktree: WorktreeRecord;
    expectedSourceOid: string;
    workerGeneration: string;
    idempotencyKey: string;
  }): Promise<{ headOid: string }> {
    assertSafeId(input.projectId, "PROJECT_ID_INVALID");
    assertSafeId(input.taskId, "TASK_ID_INVALID");
    assertGitOid(input.expectedSourceOid);
    const task = this.options.tasks.getRequired(input.taskId);
    if (task.projectId !== input.projectId) throw new Error("TASK_PROJECT_MISMATCH");
    const project = this.options.projects.findById(input.projectId);
    if (!project) throw new Error(`PROJECT_NOT_FOUND:${input.projectId}`);
    const storedLead = this.options.artifacts.getWorktree(input.taskId, "lead");
    if (!storedLead
      || input.leadWorktree.role !== "lead"
      || !sameWorktreeIdentity(storedLead, input.leadWorktree)) {
      throw new Error("LEAD_WORKTREE_RECORD_MISMATCH");
    }
    const [repositoryRoot, commonDir, worktreePath] = await Promise.all([
      realpath(project.repositoryRoot),
      realpath(project.gitCommonDir),
      realpath(storedLead.pathRealpath)
    ]);
    return this.options.lock.withLock(commonDir, async () => {
      const priorOperation = this.options.journal.getByIdempotencyKey(
        input.idempotencyKey
      );
      if (priorOperation !== null
        && (priorOperation.operationType !== "checkpoint.integrate.continue"
          || priorOperation.projectId !== input.projectId
          || priorOperation.taskId !== input.taskId)) {
        throw new Error("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INTENT");
      }
      let headBefore: string;
      if (priorOperation === null) {
        const status = await this.readService.status({
          repositoryRootRealpath: repositoryRoot,
          worktreePathRealpath: worktreePath
        });
        if (status.inProgressOperation !== "cherry-pick") {
          throw new Error("CHERRY_PICK_NOT_IN_PROGRESS");
        }
        const cherryPickHead = await this.resolveRequiredRevision(
          worktreePath,
          "CHERRY_PICK_HEAD"
        );
        if (cherryPickHead !== input.expectedSourceOid) {
          throw new Error("CHERRY_PICK_HEAD_MISMATCH");
        }
        headBefore = await this.resolveHead(worktreePath);
      } else {
        const expected = priorOperation.expected;
        if (typeof expected !== "object"
          || expected === null
          || !("headOidBefore" in expected)
          || typeof expected.headOidBefore !== "string") {
          throw new Error("RECORDED_INTEGRATION_INTENT_INVALID");
        }
        headBefore = expected.headOidBefore;
        assertGitOid(headBefore);
      }
      const createdAt = this.options.now();
      const intent: OperationIntentRecord<{
        leadWorktreeId: string;
        expectedSourceOid: string;
        headOidBefore: string;
      }> = {
        id: this.options.id(),
        projectId: input.projectId,
        taskId: input.taskId,
        repositoryCommonDirRealpath: commonDir,
        operationType: "checkpoint.integrate.continue",
        idempotencyKey: input.idempotencyKey,
        expected: {
          leadWorktreeId: storedLead.id,
          expectedSourceOid: input.expectedSourceOid,
          headOidBefore: headBefore
        },
        status: "intent",
        observation: null,
        workerGeneration: input.workerGeneration,
        createdAt,
        updatedAt: createdAt
      };
      let executionError: string | null = null;
      let continuedHead: string | null = null;
      let result: { headOid: string };
      try {
        result = await this.options.operations.run<
          typeof intent.expected,
          Record<string, unknown>,
          { headOid: string }
        >({
          intent,
          execute: async () => {
            try {
              await this.options.git.run(worktreePath, ["add", "--all"]);
              await this.options.git.run(worktreePath, [
                "cherry-pick", "--continue", "--no-gpg-sign"
              ]);
              continuedHead = await this.resolveHead(worktreePath);
            } catch (error) {
              executionError = errorMessage(error);
            }
          },
          observe: async () => {
            const finalStatus = await this.readService.status({
              repositoryRootRealpath: repositoryRoot,
              worktreePathRealpath: worktreePath
            });
            if (continuedHead === null
              || !finalStatus.clean
              || finalStatus.inProgressOperation !== null
              || !await this.hasSingleParent(worktreePath, continuedHead, headBefore)) {
              return {
                outcome: "uncertain" as const,
                actual: { continuedHead, finalStatus, executionError }
              };
            }
            return {
              outcome: "applied" as const,
              actual: { continuedHead, executionError },
              result: { headOid: continuedHead }
            };
          }
        });
      } catch (error) {
        throw new Error("CHECKPOINT_INTEGRATION_CONTINUE_NEEDS_ATTENTION", {
          cause: error
        });
      }
      this.options.artifacts.updateCheckpoint(storedLead.id, result.headOid);
      return result;
    });
  }

  private async resolveTaskRepository(input: EnsureAgentWorktreeInput): Promise<{
    project: Project;
    task: TaskRecord;
    repositoryRoot: string;
    commonDir: string;
  }> {
    const task = this.options.tasks.getRequired(input.taskId);
    if (task.projectId !== input.projectId || task.baseOid !== input.baseOid) {
      throw new Error("TASK_REPOSITORY_INPUT_MISMATCH");
    }
    const project = this.options.projects.findById(input.projectId);
    if (!project) throw new Error(`PROJECT_NOT_FOUND:${input.projectId}`);
    const [repositoryRoot, commonDir, suppliedRoot, suppliedCommon] = await Promise.all([
      realpath(project.repositoryRoot),
      realpath(project.gitCommonDir),
      realpath(input.repositoryRootRealpath),
      realpath(input.commonDirRealpath)
    ]);
    if (repositoryRoot !== suppliedRoot || commonDir !== suppliedCommon) {
      throw new Error("REPOSITORY_IDENTITY_MISMATCH");
    }
    const identity = await this.readService.inspectRepository(repositoryRoot, repositoryRoot);
    if (identity.commonDirRealpath !== commonDir) throw new Error("REPOSITORY_IDENTITY_MISMATCH");
    return { project, task, repositoryRoot, commonDir };
  }

  private isExpectedWorktree(
    observation: WorktreeObservation,
    expectedOid: string,
    targetPath: string,
    branchRef: string,
    commonDir: string
  ): boolean {
    return observation.branchOid === expectedOid
      && observation.targetExists
      && observation.matchingPath === targetPath
      && observation.matchingBranchRef === branchRef
      && observation.matchingHeadOid === expectedOid
      && observation.repositoryCommonDirRealpath === commonDir;
  }

  private async observeWorktree(
    repositoryRoot: string,
    commonDir: string,
    targetPath: string,
    branchRef: string,
    executionError: string | null
  ): Promise<WorktreeObservation> {
    const [branchOid, worktrees, targetExists] = await Promise.all([
      this.resolveRef(repositoryRoot, branchRef),
      this.readService.listWorktrees(repositoryRoot),
      pathExists(targetPath)
    ]);
    const byPath = worktrees.find((worktree) => worktree.pathRealpath === targetPath);
    const byRef = worktrees.filter((worktree) => worktree.branchRef === branchRef);
    const matching = byPath && byPath.branchRef === branchRef && byRef.length === 1 ? byPath : null;
    let repositoryCommonDirRealpath: string | null = null;
    if (matching !== null && targetExists) {
      const identity = await this.readService.inspectRepository(targetPath, targetPath);
      repositoryCommonDirRealpath = identity.commonDirRealpath;
      if (repositoryCommonDirRealpath !== commonDir) {
        throw new Error("WORKTREE_COMMON_DIR_MISMATCH");
      }
    }
    return {
      branchOid,
      targetExists,
      matchingPath: matching?.pathRealpath ?? byRef[0]?.pathRealpath ?? null,
      matchingBranchRef: matching?.branchRef ?? byPath?.branchRef ?? null,
      matchingHeadOid: matching?.headOid ?? byPath?.headOid ?? null,
      repositoryCommonDirRealpath,
      executionError
    };
  }

  private async resolveRef(cwd: string, ref: string): Promise<string | null> {
    const output = (await this.options.git.run(cwd, [
      "for-each-ref", "--count=1", "--format=%(objectname)", ref
    ])).stdout.trim();
    if (output === "") return null;
    assertGitOid(output);
    return output;
  }

  private async resolveHead(cwd: string): Promise<string> {
    const oid = (await this.options.git.run(cwd, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
    assertGitOid(oid);
    return oid;
  }

  private async resolveRequiredRevision(cwd: string, revision: string): Promise<string> {
    const oid = (await this.options.git.run(cwd, [
      "rev-parse", "--verify", `${revision}^{commit}`
    ])).stdout.trim();
    assertGitOid(oid);
    return oid;
  }

  private async hasSingleParent(
    cwd: string,
    oid: string,
    expectedParent: string
  ): Promise<boolean> {
    const parents = (await this.options.git.run(cwd, [
      "show", "-s", "--format=%P", oid
    ])).stdout.trim();
    return parents === expectedParent;
  }

  private unmergedFiles(entries: string[]): string[] {
    const files = entries.filter((entry) => entry.startsWith("u "))
      .map((entry) => entry.split(" ").slice(10).join(" "))
      .filter((path) => path.length > 0)
      .slice(0, 100);
    return [...new Set(files)].sort();
  }

  private async resolveSymbolicHead(cwd: string): Promise<string> {
    return (await this.options.git.run(cwd, ["symbolic-ref", "HEAD"])).stdout.trim();
  }

  private async observeCommit(
    worktreePath: string,
    checkpointId: string,
    executionError: string | null
  ): Promise<CommitObservation> {
    const headOid = await this.resolveHead(worktreePath);
    const [branchRef, metadata, indexTreeOid] = await Promise.all([
      this.resolveSymbolicHead(worktreePath),
      this.options.git.run(worktreePath, [
        "show", "-s", "--format=%H%x00%P%x00%T%x00%an%x00%ae%x00%B", headOid
      ]),
      this.options.git.run(worktreePath, ["write-tree"])
    ]);
    const finalHeadOid = await this.resolveHead(worktreePath);
    const fields = metadata.stdout.split("\0");
    if (fields.length !== 6) throw new Error("CHECKPOINT_COMMIT_OBSERVATION_INVALID");
    const [observedOid = "", parents = "", commitTreeOid = "", authorName = "", authorEmail = "", body = ""] = fields;
    assertGitOid(observedOid);
    assertGitOid(commitTreeOid);
    const indexOid = indexTreeOid.stdout.trim();
    assertGitOid(indexOid);
    const parentList = parents === "" ? [] : parents.split(" ");
    parentList.forEach(assertGitOid);
    const trailers = body.split(/\r?\n/)
      .map((line) => /^Branchestra-Checkpoint-Id:\s*(.+)$/i.exec(line)?.[1] ?? null)
      .filter((value): value is string => value !== null);
    return {
      headOid,
      finalHeadOid,
      observedOid,
      branchRef,
      parentOid: parentList.length === 1 ? parentList[0] ?? null : null,
      trailer: trailers.length === 1 && trailers[0] === checkpointId ? trailers[0] : null,
      indexTreeOid: indexOid,
      commitTreeOid,
      authorName,
      authorEmail,
      executionError
    };
  }
}
