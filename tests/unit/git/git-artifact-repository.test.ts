import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { GitArtifactRepository } from "../../../src/worker/git/git-artifact-repository";
import { createRepositories } from "../../../src/worker/storage/repositories";
import { openTestDatabase } from "../../fixtures/test-database";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("GitArtifactRepository", () => {
  it("maps all artifacts explicitly and preserves declared candidate checkpoint order", () => {
    const fixture = openTestDatabase();
    cleanups.push(async () => {
      fixture.db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    });
    const repositories = createRepositories(fixture.db);
    repositories.tasks.insert(fixture.records.task);
    const artifacts = new GitArtifactRepository(fixture.db);
    const lead = { ...fixture.records.worktree, currentCheckpointOid: null };
    artifacts.insertWorktree(lead);
    const first = { ...fixture.records.checkpoint, oid: "b".repeat(40) };
    const second = {
      ...fixture.records.checkpoint,
      id: "checkpoint-2",
      oid: "c".repeat(40),
      immutableRef: "refs/branchestra/checkpoints/task-1/2",
      createdAt: "2026-07-22T10:05:01.000Z"
    };
    artifacts.insertCheckpoint(first);
    artifacts.insertCheckpoint(second);
    artifacts.updateCheckpoint(lead.id, second.oid);
    const candidate = {
      ...fixture.records.candidate,
      selectedCheckpointIds: [second.id, first.id],
      testResults: []
    };
    artifacts.insertCandidate(candidate, candidate.selectedCheckpointIds);
    artifacts.insertTestResult(fixture.records.testResult);

    expect(artifacts.getWorktree(lead.taskId, "lead")).toEqual({
      ...lead,
      currentCheckpointOid: second.oid
    });
    expect(artifacts.listCheckpoints(lead.taskId)).toEqual([first, second]);
    expect(artifacts.getCandidate(candidate.id)).toEqual({
      ...candidate,
      testResults: [fixture.records.testResult]
    });
    expect(artifacts.listTestResults(candidate.id)).toEqual([fixture.records.testResult]);
  });

  it("rejects cross-task checkpoint ownership and relies on the immutable trigger", () => {
    const fixture = openTestDatabase();
    cleanups.push(async () => {
      fixture.db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    });
    const repositories = createRepositories(fixture.db);
    repositories.tasks.insert(fixture.records.task);
    const artifacts = new GitArtifactRepository(fixture.db);
    artifacts.insertWorktree(fixture.records.worktree);

    expect(() => artifacts.insertCheckpoint({
      ...fixture.records.checkpoint,
      taskId: "another-task"
    })).toThrow("CHECKPOINT_WORKTREE_TASK_MISMATCH");
    artifacts.insertCheckpoint(fixture.records.checkpoint);
    expect(() => fixture.db.prepare("UPDATE checkpoints SET oid = ? WHERE id = ?")
      .run("d".repeat(40), fixture.records.checkpoint.id)).toThrow("CHECKPOINT_IMMUTABLE");
    expect(artifacts.getCheckpoint(fixture.records.checkpoint.id)).toEqual(fixture.records.checkpoint);
  });
});
