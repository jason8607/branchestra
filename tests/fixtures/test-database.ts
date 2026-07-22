import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentRunRecord,
  ApprovalReceipt,
  ApprovalRequest,
  CheckpointRecord,
  IntegrationCandidate,
  Project,
  Room,
  TaskRecord,
  TestResultRecord,
  WorktreeRecord
} from "../../src/shared/contracts/domain";
import type { OperationRecord } from "../../src/worker/operations/operation-journal";
import { openDatabase, type Database } from "../../src/worker/storage/database";
import { runMigrations } from "../../src/worker/storage/migrations";

const CREATED_AT = "2026-07-22T10:00:00.000Z";

export interface TestDatabaseRecords {
  project: Project;
  room: Room;
  task: TaskRecord;
  scopeApprovalRequest: Extract<ApprovalRequest, { kind: "task_scope" }>;
  scopeApproval: Extract<ApprovalReceipt, { kind: "task_scope" }>;
  sensitiveApprovalRequest: Extract<ApprovalRequest, { kind: "external_operation" }>;
  sensitiveApproval: Extract<ApprovalReceipt, { kind: "external_operation" }>;
  operationIntent: OperationRecord<{ nested: { alpha: number; beta: number }; ref: string }, never>;
  run: AgentRunRecord;
  worktree: WorktreeRecord;
  checkpoint: CheckpointRecord;
  testResult: TestResultRecord;
  candidate: IntegrationCandidate;
}

function createRecords(): TestDatabaseRecords {
  const project: Project = {
    id: "10000000-0000-4000-8000-000000000001",
    repositoryRoot: "/tmp/branchestra-repository",
    gitCommonDir: "/tmp/branchestra-repository/.git",
    displayName: "branchestra-repository",
    headOid: "a".repeat(40),
    defaultBranch: "main",
    createdAt: CREATED_AT
  };
  const room: Room = {
    id: "20000000-0000-4000-8000-000000000001",
    projectId: project.id,
    title: "Task room",
    createdAt: CREATED_AT
  };
  const task: TaskRecord = {
    id: "task-1",
    roomId: room.id,
    projectId: project.id,
    requestEventId: "30000000-0000-4000-8000-000000000001",
    requestText: "@Claude implement durable task storage",
    leadProvider: "claude",
    targetRef: "refs/heads/main",
    baseOid: "a".repeat(40),
    state: "AwaitingApproval",
    interruptedFromState: null,
    collaborationRoundsUsed: 0,
    collaborationRoundBudget: 2,
    humanRevisionCount: 0,
    revisionKind: null,
    scopeApprovalId: null,
    activeCandidateId: null,
    failure: null,
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT
  };
  const scope = {
    repositoryRootRealpath: project.repositoryRoot,
    gitCommonDirRealpath: project.gitCommonDir,
    writableRootsRealpath: [project.repositoryRoot],
    commandClasses: ["test", "lint"] as Array<"test" | "lint">,
    allowCollaborator: true,
    toolNetwork: false,
    maxRunMs: 120_000,
    collaborationRoundBudget: 2 as const
  };
  const scopeApprovalRequest: Extract<ApprovalRequest, { kind: "task_scope" }> = {
    id: "scope-request-1",
    taskId: task.id,
    kind: "task_scope",
    scope,
    scopeHash: "sha256:scope",
    requestedGeneration: "generation-1",
    status: "pending",
    requestedAt: CREATED_AT
  };
  const scopeApproval: Extract<ApprovalReceipt, { kind: "task_scope" }> = {
    id: "approval-1",
    requestId: scopeApprovalRequest.id,
    taskId: task.id,
    kind: "task_scope",
    scope,
    decision: "approved",
    scopeHash: scopeApprovalRequest.scopeHash,
    workerGeneration: "generation-1",
    survivesWorkerRestart: true,
    decidedAt: "2026-07-22T10:01:00.000Z"
  };
  const sensitiveApprovalRequest: Extract<ApprovalRequest, { kind: "external_operation" }> = {
    id: "external-request-1",
    taskId: task.id,
    kind: "external_operation",
    scope: { operation: "git.push" },
    scopeHash: "sha256:external-operation",
    requestedGeneration: "generation-1",
    status: "pending",
    requestedAt: CREATED_AT
  };
  const sensitiveApproval: Extract<ApprovalReceipt, { kind: "external_operation" }> = {
    id: "approval-sensitive-1",
    requestId: sensitiveApprovalRequest.id,
    taskId: task.id,
    kind: "external_operation",
    scope: sensitiveApprovalRequest.scope,
    decision: "approved",
    scopeHash: sensitiveApprovalRequest.scopeHash,
    workerGeneration: "generation-1",
    survivesWorkerRestart: false,
    decidedAt: "2026-07-22T10:02:00.000Z"
  };
  const run: AgentRunRecord = {
    id: "run-1",
    taskId: task.id,
    provider: "claude",
    role: "lead",
    providerSessionId: "session-1",
    contextVersion: 3,
    contextHash: "sha256:context",
    state: "running",
    startedAt: "2026-07-22T10:03:00.000Z",
    finishedAt: null
  };
  const worktree: WorktreeRecord = {
    id: "worktree-1",
    taskId: task.id,
    role: "lead",
    pathRealpath: "/tmp/branchestra-worktree",
    branchRef: "refs/heads/branchestra/task-1",
    baseOid: task.baseOid,
    currentCheckpointOid: "b".repeat(40),
    retained: true,
    createdAt: "2026-07-22T10:04:00.000Z"
  };
  const checkpoint: CheckpointRecord = {
    id: "checkpoint-1",
    taskId: task.id,
    worktreeId: worktree.id,
    authorProvider: "claude",
    purpose: "implementation",
    oid: "b".repeat(40),
    immutableRef: "refs/branchestra/checkpoints/task-1/1",
    createdAt: "2026-07-22T10:05:00.000Z"
  };
  const testResult: TestResultRecord = {
    id: "test-result-1",
    taskId: task.id,
    candidateId: "candidate-1",
    commandId: "unit",
    executableRealpath: "/usr/bin/env",
    argv: ["pnpm", "test:unit"],
    exitCode: 0,
    stdoutHash: "sha256:stdout",
    stderrHash: "sha256:stderr",
    durationMs: 1_234,
    logReference: "logs/test-result-1.log",
    createdAt: "2026-07-22T10:06:00.000Z"
  };
  const candidate: IntegrationCandidate = {
    id: "candidate-1",
    taskId: task.id,
    leadWorktreeId: worktree.id,
    targetRef: task.targetRef,
    baseOid: task.baseOid,
    candidateOid: "c".repeat(40),
    immutableRef: "refs/branchestra/candidates/task-1/1",
    diffHash: "sha256:diff",
    testSetHash: "sha256:test-set",
    diffSummary: {
      filesChanged: 1,
      additions: 8,
      deletions: 2,
      files: [{ path: "src/task.ts", status: "modified", additions: 8, deletions: 2 }]
    },
    selectedCheckpointIds: [checkpoint.id],
    testResults: [testResult],
    unresolved: [{ source: "git", summary: "Target may advance before merge" }],
    verificationStatus: "passed",
    createdAt: "2026-07-22T10:07:00.000Z"
  };
  return {
    project,
    room,
    task,
    scopeApprovalRequest,
    scopeApproval,
    sensitiveApprovalRequest,
    sensitiveApproval,
    operationIntent: {
      id: "operation-1",
      projectId: project.id,
      taskId: task.id,
      repositoryCommonDirRealpath: project.gitCommonDir,
      operationType: "git.update-ref",
      idempotencyKey: "operation-key-1",
      expected: { nested: { beta: 2, alpha: 1 }, ref: task.targetRef },
      status: "intent",
      observation: null,
      workerGeneration: "generation-1",
      createdAt: "2026-07-22T10:08:00.000Z",
      updatedAt: "2026-07-22T10:08:00.000Z"
    },
    run,
    worktree,
    checkpoint,
    testResult,
    candidate
  };
}

function seedProjectAndRoom(db: Database, records: TestDatabaseRecords): void {
  db.prepare("INSERT OR IGNORE INTO projects(id, repository_root, git_common_dir, display_name, head_oid, default_branch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(records.project.id, records.project.repositoryRoot, records.project.gitCommonDir,
      records.project.displayName, records.project.headOid, records.project.defaultBranch,
      records.project.createdAt);
  db.prepare("INSERT OR IGNORE INTO rooms(id, project_id, title, created_at) VALUES (?, ?, ?, ?)")
    .run(records.room.id, records.room.projectId, records.room.title, records.room.createdAt);
}

export function openTestDatabase(existingPath?: string): {
  db: Database;
  path: string;
  directory: string;
  records: TestDatabaseRecords;
} {
  const directory = existingPath ? join(existingPath, "..") : mkdtempSync(join(tmpdir(), "branchestra-storage-"));
  const path = existingPath ?? join(directory, "branchestra.sqlite3");
  const db = openDatabase(path);
  runMigrations(db);
  const records = createRecords();
  seedProjectAndRoom(db, records);
  return { db, path, directory, records };
}
