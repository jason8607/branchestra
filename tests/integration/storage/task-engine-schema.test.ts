import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalReceipt, ApprovalRequest } from "../../../src/shared/contracts/domain";
import { openTestDatabase } from "../../fixtures/test-database";
import { runMigrations } from "../../../src/worker/storage/migrations";
import { createRepositories } from "../../../src/worker/storage/repositories";

describe("task engine schema", () => {
  const opened: Array<{ close(): void }> = [];
  const directories = new Set<string>();

  afterEach(() => {
    opened.splice(0).forEach((db) => db.close());
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    directories.clear();
  });

  function fixture(path?: string): ReturnType<typeof openTestDatabase> {
    const result = openTestDatabase(path);
    opened.push(result.db);
    directories.add(dirname(result.path));
    return result;
  }

  it("applies task engine migrations once across repeated runs and reopen", () => {
    const first = fixture();
    runMigrations(first.db);
    expect(first.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all())
      .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }]);
    first.db.close();
    opened.pop();

    const second = fixture(first.path);
    runMigrations(second.db);
    expect(second.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all())
      .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }]);
    expect(second.db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get())
      .toEqual({ count: 1 });
  });

  it("persists every recovery input across a database reopen", () => {
    const first = fixture();
    const repositories = createRepositories(first.db);
    const { records } = first;
    repositories.tasks.insert(records.task);
    repositories.tasks.insertRun(records.run);
    repositories.approvals.insertRequest(records.scopeApprovalRequest);
    repositories.approvals.decideRequest(records.scopeApprovalRequest.id, records.scopeApproval);
    repositories.operations.recordIntent(records.operationIntent);
    first.db.prepare("INSERT INTO worktrees(id, task_id, role, path_realpath, branch_ref, base_oid, current_checkpoint_oid, retained, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(records.worktree.id, records.worktree.taskId, records.worktree.role,
        records.worktree.pathRealpath, records.worktree.branchRef, records.worktree.baseOid,
        records.worktree.currentCheckpointOid, 1, records.worktree.createdAt);
    first.db.prepare("INSERT INTO checkpoints(id, task_id, worktree_id, author_provider, purpose, oid, immutable_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(records.checkpoint.id, records.checkpoint.taskId, records.checkpoint.worktreeId,
        records.checkpoint.authorProvider, records.checkpoint.purpose, records.checkpoint.oid,
        records.checkpoint.immutableRef, records.checkpoint.createdAt);
    first.db.prepare("INSERT INTO test_results(id, task_id, candidate_id, command_id, executable_realpath, argv_json, exit_code, stdout_hash, stderr_hash, duration_ms, log_reference, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(records.testResult.id, records.testResult.taskId, records.testResult.candidateId,
        records.testResult.commandId, records.testResult.executableRealpath,
        JSON.stringify(records.testResult.argv), records.testResult.exitCode,
        records.testResult.stdoutHash, records.testResult.stderrHash, records.testResult.durationMs,
        records.testResult.logReference, records.testResult.createdAt);
    first.db.prepare("INSERT INTO integration_candidates(id, task_id, lead_worktree_id, target_ref, base_oid, candidate_oid, immutable_ref, diff_hash, test_set_hash, diff_summary_json, unresolved_json, verification_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(records.candidate.id, records.candidate.taskId, records.candidate.leadWorktreeId,
        records.candidate.targetRef, records.candidate.baseOid, records.candidate.candidateOid,
        records.candidate.immutableRef, records.candidate.diffHash, records.candidate.testSetHash,
        JSON.stringify(records.candidate.diffSummary), JSON.stringify(records.candidate.unresolved),
        records.candidate.verificationStatus, records.candidate.createdAt);
    first.db.prepare("INSERT INTO candidate_checkpoints(candidate_id, checkpoint_id, ordinal) VALUES (?, ?, ?)")
      .run(records.candidate.id, records.checkpoint.id, 0);
    first.db.close();
    opened.pop();

    const second = fixture(first.path);
    const reopened = createRepositories(second.db);
    expect(reopened.tasks.getRequired(records.task.id)).toEqual(records.task);
    expect(reopened.tasks.getRun(records.run.id)).toEqual(records.run);
    expect(reopened.approvals.getRequired(records.scopeApproval.id)).toEqual(records.scopeApproval);
    expect(reopened.operations.listIncomplete(records.project.id)).toEqual([
      { ...records.operationIntent, expected: { nested: { alpha: 1, beta: 2 }, ref: records.task.targetRef } }
    ]);
    expect(second.db.prepare("SELECT path_realpath, branch_ref, current_checkpoint_oid FROM worktrees WHERE id = ?").get(records.worktree.id))
      .toEqual({
        path_realpath: records.worktree.pathRealpath,
        branch_ref: records.worktree.branchRef,
        current_checkpoint_oid: records.worktree.currentCheckpointOid
      });
    expect(second.db.prepare("SELECT oid, immutable_ref FROM checkpoints WHERE id = ?").get(records.checkpoint.id))
      .toEqual({ oid: records.checkpoint.oid, immutable_ref: records.checkpoint.immutableRef });
    expect(second.db.prepare("SELECT argv_json, stdout_hash, stderr_hash, log_reference FROM test_results WHERE id = ?").get(records.testResult.id))
      .toEqual({
        argv_json: JSON.stringify(records.testResult.argv),
        stdout_hash: records.testResult.stdoutHash,
        stderr_hash: records.testResult.stderrHash,
        log_reference: records.testResult.logReference
      });
    expect(second.db.prepare("SELECT diff_summary_json, unresolved_json, verification_status FROM integration_candidates WHERE id = ?").get(records.candidate.id))
      .toEqual({
        diff_summary_json: JSON.stringify(records.candidate.diffSummary),
        unresolved_json: JSON.stringify(records.candidate.unresolved),
        verification_status: records.candidate.verificationStatus
      });
    expect(second.db.prepare("SELECT checkpoint_id, ordinal FROM candidate_checkpoints WHERE candidate_id = ?").all(records.candidate.id))
      .toEqual([{ checkpoint_id: records.checkpoint.id, ordinal: 0 }]);
  });

  it("enforces task foreign keys, state checks, and checkpoint immutability", () => {
    const current = fixture();
    const invalidTask = { ...current.records.task, id: "bad-task", roomId: "missing-room" };
    expect(() => createRepositories(current.db).tasks.insert(invalidTask)).toThrow(/FOREIGN KEY/);
    expect(() => current.db.prepare("INSERT INTO tasks(id, room_id, project_id, request_event_id, request_text, lead_provider, target_ref, base_oid, state, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("bad-state-task", current.records.room.id, current.records.project.id, "bad-event",
        "bad", "claude", "refs/heads/main", "a".repeat(40), "Unknown", 1,
        current.records.task.createdAt, current.records.task.updatedAt)).toThrow(/CHECK constraint/);

    const repositories = createRepositories(current.db);
    repositories.tasks.insert(current.records.task);
    const worktree = current.records.worktree;
    const checkpoint = current.records.checkpoint;
    current.db.prepare("INSERT INTO worktrees(id, task_id, role, path_realpath, branch_ref, base_oid, current_checkpoint_oid, retained, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(worktree.id, worktree.taskId, worktree.role, worktree.pathRealpath,
        worktree.branchRef, worktree.baseOid, worktree.currentCheckpointOid, 1,
        worktree.createdAt);
    current.db.prepare("INSERT INTO checkpoints(id, task_id, worktree_id, author_provider, purpose, oid, immutable_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(checkpoint.id, checkpoint.taskId, checkpoint.worktreeId, checkpoint.authorProvider,
        checkpoint.purpose, checkpoint.oid, checkpoint.immutableRef, checkpoint.createdAt);
    expect(() => current.db.prepare("UPDATE checkpoints SET oid = ? WHERE id = ?")
      .run("d".repeat(40), checkpoint.id)).toThrow("CHECKPOINT_IMMUTABLE");
    expect(() => current.db.prepare("UPDATE checkpoints SET immutable_ref = ? WHERE id = ?")
      .run("refs/changed", checkpoint.id)).toThrow("CHECKPOINT_IMMUTABLE");
  });

  it("rejects a stale task version", () => {
    const current = fixture();
    const tasks = createRepositories(current.db).tasks;
    tasks.insert(current.records.task);
    tasks.updateState({ ...current.records.task, state: "Preparing", version: 2 }, 1);
    expect(() => tasks.updateState({ ...current.records.task, state: "Working", version: 3 }, 1))
      .toThrow(`TASK_VERSION_CONFLICT:${current.records.task.id}`);
  });

  it("decides an approval request atomically and validates its receipt", () => {
    const current = fixture();
    const repositories = createRepositories(current.db);
    repositories.tasks.insert(current.records.task);
    repositories.approvals.insertRequest(current.records.scopeApprovalRequest);
    repositories.approvals.insert({ ...current.records.scopeApproval, requestId: current.records.scopeApprovalRequest.id });
    expect(() => repositories.approvals.decideRequest(current.records.scopeApprovalRequest.id, {
      ...current.records.scopeApproval,
      id: current.records.scopeApproval.id
    })).toThrow();
    expect(repositories.approvals.getRequest(current.records.scopeApprovalRequest.id)?.status)
      .toBe("pending");
    expect(() => repositories.approvals.decideRequest(current.records.scopeApprovalRequest.id, {
      ...current.records.scopeApproval,
      id: "approval-mismatch",
      scopeHash: "sha256:different"
    })).toThrow(`APPROVAL_RECEIPT_MISMATCH:${current.records.scopeApprovalRequest.id}`);
  });

  it("rejects a receipt from a different worker generation atomically", () => {
    const current = fixture();
    const repositories = createRepositories(current.db);
    repositories.tasks.insert(current.records.task);
    repositories.approvals.insertRequest(current.records.sensitiveApprovalRequest);

    expect(() => repositories.approvals.decideRequest(
      current.records.sensitiveApprovalRequest.id,
      { ...current.records.sensitiveApproval, workerGeneration: "generation-2" }
    )).toThrow(`APPROVAL_GENERATION_MISMATCH:${current.records.sensitiveApprovalRequest.id}`);
    expect(repositories.approvals.getRequest(current.records.sensitiveApprovalRequest.id)?.status)
      .toBe("pending");
    expect(repositories.approvals.get(current.records.sensitiveApproval.id)).toBeNull();
  });

  it.each([
    ["additional_round", { additionalRounds: 1 }, "sha256:additional"],
    ["external_operation", { operation: "git.push" }, "sha256:external"],
    ["final_merge", {
      targetRef: "refs/heads/main",
      baseOid: "a".repeat(40),
      candidateOid: "b".repeat(40),
      diffHash: "sha256:diff",
      testSetHash: "sha256:tests"
    }, "sha256:merge"]
  ] as const)("rejects restart-safe %s receipts before changing request status", (kind, scope, scopeHash) => {
    const current = fixture();
    const repositories = createRepositories(current.db);
    repositories.tasks.insert(current.records.task);
    const request = {
      id: `${kind}-request`,
      taskId: current.records.task.id,
      kind,
      scope,
      scopeHash,
      requestedGeneration: "generation-1",
      status: "pending",
      requestedAt: current.records.task.createdAt
    } as ApprovalRequest;
    const receipt = {
      id: `${kind}-approval`,
      requestId: request.id,
      taskId: request.taskId,
      kind,
      scope,
      decision: "approved",
      scopeHash,
      workerGeneration: "generation-1",
      survivesWorkerRestart: true,
      decidedAt: current.records.task.updatedAt
    } as ApprovalReceipt;
    repositories.approvals.insertRequest(request);

    expect(() => repositories.approvals.decideRequest(request.id, receipt))
      .toThrow(`APPROVAL_RESTART_SURVIVAL_INVALID:${kind}`);
    expect(repositories.approvals.getRequest(request.id)?.status).toBe("pending");
    expect(repositories.approvals.get(receipt.id)).toBeNull();
  });

  it("persists non-surviving sensitive approval and invalidates it after generation change", () => {
    const current = fixture();
    const repositories = createRepositories(current.db);
    repositories.tasks.insert(current.records.task);
    repositories.approvals.insertRequest(current.records.sensitiveApprovalRequest);
    repositories.approvals.decideRequest(
      current.records.sensitiveApprovalRequest.id,
      current.records.sensitiveApproval
    );

    expect(repositories.approvals.getRequired(current.records.sensitiveApproval.id)
      .survivesWorkerRestart).toBe(false);
    expect(repositories.approvals.invalidateSensitiveFromOlderGeneration("generation-2"))
      .toEqual([current.records.sensitiveApproval.id]);
    expect(repositories.approvals.get(current.records.sensitiveApproval.id)).toBeNull();
  });

  it("rejects every non-intent initial operation status before SQL", () => {
    const current = fixture();
    const repositories = createRepositories(current.db);
    repositories.tasks.insert(current.records.task);

    for (const status of ["executing", "observed", "completed", "needs_attention"] as const) {
      const invalid = {
        ...current.records.operationIntent,
        id: `operation-${status}`,
        idempotencyKey: `operation-key-${status}`,
        status
      } as unknown as typeof current.records.operationIntent;
      expect(() => repositories.operations.recordIntent(invalid))
        .toThrow("OPERATION_INTENT_STATUS_REQUIRED");
    }
    expect(current.db.prepare("SELECT count(*) AS count FROM operation_journal").get())
      .toEqual({ count: 0 });
  });

  it("rejects a non-null initial operation observation before SQL", () => {
    const current = fixture();
    const repositories = createRepositories(current.db);
    repositories.tasks.insert(current.records.task);
    const invalid = {
      ...current.records.operationIntent,
      observation: { oid: "b".repeat(40) }
    } as unknown as typeof current.records.operationIntent;

    expect(() => repositories.operations.recordIntent(invalid))
      .toThrow("OPERATION_INTENT_OBSERVATION_MUST_BE_NULL");
    expect(current.db.prepare("SELECT count(*) AS count FROM operation_journal").get())
      .toEqual({ count: 0 });
  });

  it("canonicalizes operation intent and enforces idempotency and status preconditions", () => {
    const current = fixture();
    const repositories = createRepositories(current.db);
    repositories.tasks.insert(current.records.task);
    const first = repositories.operations.recordIntent(current.records.operationIntent);
    const replay = repositories.operations.recordIntent({
      ...current.records.operationIntent,
      expected: { ref: current.records.task.targetRef, nested: { beta: 2, alpha: 1 } }
    });
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.record).toEqual(first.record);
    expect(() => repositories.operations.recordIntent({
      ...current.records.operationIntent,
      expected: { nested: { alpha: 1, beta: 3 }, ref: current.records.task.targetRef }
    })).toThrow("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INTENT");
    expect(() => repositories.operations.complete(current.records.operationIntent.id))
      .toThrow(`OPERATION_STATUS_PRECONDITION:${current.records.operationIntent.id}:observed:intent`);
    repositories.operations.markExecuting(current.records.operationIntent.id);
    repositories.operations.recordObservation(current.records.operationIntent.id, { oid: "b".repeat(40) });
    repositories.operations.complete(current.records.operationIntent.id);
    expect(repositories.operations.getByIdempotencyKey(current.records.operationIntent.idempotencyKey)?.status)
      .toBe("completed");
    expect(() => repositories.operations.needsAttention(current.records.operationIntent.id, { reason: "late" }))
      .toThrow(`OPERATION_ALREADY_COMPLETED:${current.records.operationIntent.id}`);
  });
});
