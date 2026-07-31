import { mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CleanupRepository } from "../../src/worker/cleanup/cleanup-repository";
import { CleanupCommandService } from "../../src/worker/cleanup/cleanup-command-service";
import { createIdempotencyStore } from "../../src/worker/storage/idempotency-store";
import { openTestDatabase } from "../fixtures/test-database";
import { CleanupService } from "../../src/worker/cleanup/cleanup-service";
import { createGitManagerFixture } from "../fixtures/git-repository";
import { GitCommandRunner } from "../../src/worker/git/git-command-runner";
import { JournaledOperationRunner } from "../../src/worker/operations/journaled-operation-runner";
import { GitOperationReconciler, reconcileAppliedArchiveOperations } from "../../src/worker/git/git-operation-reconciler";
import { createRepositories } from "../../src/worker/storage/repositories";

it("removes only selected local room metadata and records an ID-only audit", () => {
  const harness = openTestDatabase();
  const cleanup = new CleanupRepository(harness.db, () => "2026-07-31T00:00:00.000Z");
  cleanup.removeRoom(
    { kind: "room", roomId: harness.records.room.id, eventCount: 0, throughSeq: 0, activeTaskCount: 0, confirmation: `DELETE ${harness.records.room.id}` },
    { kind: "room", roomId: harness.records.room.id, eventCount: 0, throughSeq: 0, activeTaskCount: 0 },
  );
  expect(harness.db.prepare("SELECT id FROM rooms WHERE id = ?").get(harness.records.room.id)).toBeUndefined();
  expect(harness.db.prepare("SELECT kind, deleted_id FROM local_deletion_audit").all()).toEqual([{ kind: "room", deleted_id: harness.records.room.id }]);
  expect(harness.db.prepare("SELECT id FROM projects WHERE id = ?").get(harness.records.project.id)).toEqual({ id: harness.records.project.id });
  harness.db.close();
});

it("previews and idempotently removes only a task-free room", () => {
  const harness = openTestDatabase();
  const service = new CleanupCommandService({
    database: harness.db,
    repository: new CleanupRepository(harness.db, () => "2026-07-31T00:00:00.000Z"),
    idempotency: createIdempotencyStore(harness.db, () => "2026-07-31T00:00:00.000Z")
  });
  const preview = service.previewRoom(harness.records.room.id);
  expect(preview).toEqual({
    kind: "room",
    roomId: harness.records.room.id,
    eventCount: 0,
    throughSeq: 0,
    activeTaskCount: 0
  });
  const command = {
    idempotencyKey: "remove-empty-room",
    requestType: "cleanup.room.remove",
    requestHash: "request-hash",
    workerGeneration: "generation-1"
  };
  const receipt = { ...preview, confirmation: `DELETE ${preview.roomId}` };
  expect(service.removeRoom(receipt, command)).toMatchObject({ replayed: false });
  expect(service.removeRoom(receipt, command)).toMatchObject({ replayed: true });
  expect(harness.db.prepare("SELECT id FROM rooms WHERE id = ?").get(preview.roomId)).toBeUndefined();
  const projectPreview = service.previewProject(harness.records.project.id);
  expect(projectPreview).toEqual({
    kind: "project",
    projectId: harness.records.project.id,
    roomCount: 0,
    activeTaskCount: 0
  });
  const projectCommand = {
    ...command,
    idempotencyKey: "remove-empty-project",
    requestType: "cleanup.project.remove",
    requestHash: "project-request-hash"
  };
  const projectReceipt = { ...projectPreview, confirmation: `DELETE ${projectPreview.projectId}` };
  expect(service.removeProject(projectReceipt, projectCommand)).toMatchObject({ replayed: false });
  expect(service.removeProject(projectReceipt, projectCommand)).toMatchObject({ replayed: true });
  expect(harness.db.prepare("SELECT id FROM projects WHERE id = ?").get(projectPreview.projectId)).toBeUndefined();
  harness.db.close();
});

it("archives dirty worktree bytes, unregisters the worktree, and preserves refs", async () => {
  const harness = await createGitManagerFixture();
  try {
    const worktree = await harness.manager.ensureAgentWorktree({
      projectId: harness.project.id,
      taskId: harness.task.id,
      role: "lead",
      baseOid: harness.task.baseOid,
      repositoryRootRealpath: harness.project.repositoryRoot,
      commonDirRealpath: harness.project.gitCommonDir,
      workerGeneration: "generation-archive",
      idempotencyKey: "ensure-archive-worktree"
    });
    await harness.repository.writeAt(worktree.pathRealpath, "tracked.txt", "checkpoint bytes\n");
    const checkpoint = await harness.manager.createCheckpoint({
      projectId: harness.project.id,
      taskId: harness.task.id,
      worktree,
      authorProvider: "claude",
      purpose: "implementation",
      message: "Archive fixture checkpoint",
      checkpointId: "archive-checkpoint",
      workerGeneration: "generation-archive",
      idempotencyKey: "archive-checkpoint"
    });
    await harness.repository.writeAt(worktree.pathRealpath, "untracked.txt", "keep me\n");
    harness.db.prepare("UPDATE tasks SET state = 'Completed' WHERE id = ?").run(harness.task.id);
    const service = new CleanupService({
      database: harness.db,
      git: new GitCommandRunner(),
      lock: harness.lock,
      operations: new JournaledOperationRunner(harness.journal),
      recoveryRoot: join(harness.managedWorktreeRoot, "..", "recovery", "worktrees"),
      workerGeneration: "generation-archive",
      id: () => "archive-operation-id",
      now: () => "2026-07-31T00:00:00.000Z"
    });
    const preview = await service.previewWorktree(worktree.id);
    expect(preview.dirtyHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    const archived = await service.archiveWorktree({ ...preview, allowDirtyArchive: true }, "archive-worktree-1");

    expect(await readFile(join(archived.recoveryPath, "untracked.txt"), "utf8")).toBe("keep me\n");
    expect((await harness.repository.run(["rev-parse", checkpoint.immutableRef])).stdout.trim()).toBe(checkpoint.oid);
    expect((await harness.repository.run(["worktree", "list", "--porcelain"])).stdout).not.toContain(worktree.pathRealpath);
    expect(harness.artifacts.getWorktree(harness.task.id, "lead")?.pathRealpath).toBe(archived.recoveryPath);
  } finally {
    await harness.cleanup();
  }
});

it("reconciles a crash after worktree bytes moved but before the archive record updated", async () => {
  const harness = await createGitManagerFixture();
  try {
    const worktree = await harness.manager.ensureAgentWorktree({
      projectId: harness.project.id,
      taskId: harness.task.id,
      role: "lead",
      baseOid: harness.task.baseOid,
      repositoryRootRealpath: harness.project.repositoryRoot,
      commonDirRealpath: harness.project.gitCommonDir,
      workerGeneration: "generation-reconcile-archive",
      idempotencyKey: "ensure-reconcile-archive-worktree"
    });
    await harness.repository.writeAt(worktree.pathRealpath, "untracked.txt", "survives crash\n");
    const recoveryPath = join(harness.managedWorktreeRoot, "..", "recovery", "worktrees", worktree.id, "crashed-operation");
    await mkdir(join(recoveryPath, ".."), { recursive: true });
    await rename(worktree.pathRealpath, recoveryPath);
    const git = new GitCommandRunner();
    await git.run(harness.project.repositoryRoot, ["worktree", "prune", "--expire", "now"]);
    const repositories = createRepositories(harness.db);
    repositories.operations.recordIntent({
      id: "crashed-archive-operation",
      projectId: harness.project.id,
      taskId: harness.task.id,
      repositoryCommonDirRealpath: harness.project.gitCommonDir,
      operationType: "archive-worktree",
      idempotencyKey: "crashed-archive-operation",
      expected: {
        worktreeId: worktree.id,
        source: worktree.pathRealpath,
        recoveryPath,
        headOid: harness.task.baseOid,
        dirtyHash: "sha256:crash-fixture"
      },
      status: "intent",
      observation: null,
      workerGeneration: "generation-reconcile-archive",
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z"
    });
    const reconciler = new GitOperationReconciler({
      projects: repositories.projects,
      git,
      artifacts: harness.artifacts
    });
    await expect(reconcileAppliedArchiveOperations({
      operations: repositories.operations,
      reconciler
    })).resolves.toEqual(["crashed-archive-operation"]);
    expect(repositories.operations.listIncomplete()
      .find(({ id }) => id === "crashed-archive-operation")).toBeUndefined();
    expect(harness.artifacts.getWorktree(harness.task.id, "lead")?.pathRealpath).toBe(recoveryPath);
    expect(await readFile(join(recoveryPath, "untracked.txt"), "utf8")).toBe("survives crash\n");
  } finally {
    await harness.cleanup();
  }
});
