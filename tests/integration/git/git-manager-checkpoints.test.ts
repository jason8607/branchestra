import { describe, expect, it } from "vitest";
import { createPreparedLeadFixture } from "../../fixtures/git-repository";
import type { GitRepositoryFixture } from "../../fixtures/git-repository";

const GENERATION = "00000000-0000-4000-8000-000000000001";

describe("GitManager checkpoints", () => {
  it("commits with app identity, skips hooks, and creates a create-only checkpoint ref", async () => {
    const fixture = await createPreparedLeadFixture();
    try {
      await fixture.repository.writeAt(fixture.lead.pathRealpath, "feature.txt", "implemented\n");
      await fixture.installHookThatWrites("pre-commit", fixture.hookSentinel);
      const checkpoint = await fixture.manager.createCheckpoint({
        projectId: fixture.project.id,
        taskId: fixture.task.id,
        worktree: fixture.lead,
        authorProvider: "claude",
        purpose: "implementation",
        message: "Implement feature",
        workerGeneration: GENERATION,
        idempotencyKey: "checkpoint-1",
        checkpointId: "checkpoint-1"
      });

      await expect(fixture.git("show", "-s", "--format=%an <%ae>", checkpoint.oid))
        .resolves.toBe("Branchestra <branchestra@localhost>");
      await expect(fixture.pathExists(fixture.hookSentinel)).resolves.toBe(false);
      await expect(fixture.git("rev-parse", "refs/branchestra/checkpoints/checkpoint-1"))
        .resolves.toBe(checkpoint.oid);
      const commitJournal = fixture.journal.getByIdempotencyKey("checkpoint-1:commit");
      expect(commitJournal?.status).toBe("completed");
      expect(commitJournal?.observation).toMatchObject({
        outcome: "applied",
        actual: {
          parentOid: fixture.repository.initialOid,
          trailer: "checkpoint-1",
          authorName: "Branchestra",
          authorEmail: "branchestra@localhost"
        }
      });
      const actual = (commitJournal?.observation as {
        actual: { indexTreeOid: string; commitTreeOid: string };
      }).actual;
      expect(actual.indexTreeOid).toBe(actual.commitTreeOid);
      await expect(fixture.manager.createCheckpoint({
        projectId: fixture.project.id,
        taskId: fixture.task.id,
        worktree: fixture.lead,
        authorProvider: "claude",
        purpose: "implementation",
        message: "Different content",
        workerGeneration: GENERATION,
        idempotencyKey: "checkpoint-1-other",
        checkpointId: "checkpoint-1"
      })).rejects.toThrow("IMMUTABLE_CHECKPOINT_REF_CONFLICT");
    } finally {
      await fixture.cleanup();
    }
  });

  it("creates an immutable commit for an empty checkpoint", async () => {
    const fixture = await createPreparedLeadFixture();
    try {
      const checkpoint = await fixture.manager.createCheckpoint({
        projectId: fixture.project.id,
        taskId: fixture.task.id,
        worktree: fixture.lead,
        authorProvider: "claude",
        purpose: "review",
        message: "Record empty review",
        workerGeneration: GENERATION,
        idempotencyKey: "empty-checkpoint",
        checkpointId: "empty-checkpoint"
      });

      expect(checkpoint.oid).not.toBe(fixture.repository.initialOid);
      await expect(fixture.git("show", "-s", "--format=%P", checkpoint.oid))
        .resolves.toBe(fixture.repository.initialOid);
      expect(fixture.artifacts.getWorktree(fixture.task.id, "lead")?.currentCheckpointOid)
        .toBe(checkpoint.oid);
      expect(fixture.artifacts.getCheckpoint(checkpoint.id)).toEqual(checkpoint);
    } finally {
      await fixture.cleanup();
    }
  });

  it("returns the same checkpoint for the same completed idempotency key", async () => {
    const fixture = await createPreparedLeadFixture();
    try {
      await fixture.repository.writeAt(fixture.lead.pathRealpath, "same.txt", "same\n");
      const input = {
        projectId: fixture.project.id,
        taskId: fixture.task.id,
        worktree: fixture.lead,
        authorProvider: "claude" as const,
        purpose: "implementation" as const,
        message: "Idempotent checkpoint",
        workerGeneration: GENERATION,
        idempotencyKey: "same-checkpoint",
        checkpointId: "same-checkpoint"
      };
      const first = await fixture.manager.createCheckpoint(input);
      const second = await fixture.manager.createCheckpoint(input);

      expect(second).toEqual(first);
      await expect(fixture.git("rev-list", "--count", fixture.lead.branchRef)).resolves.toBe("2");
      expect(fixture.artifacts.listCheckpoints(fixture.task.id)).toHaveLength(1);
      await expect(fixture.manager.createCheckpoint({
        ...input,
        message: "Changed intent with reused key"
      })).rejects.toThrow("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INTENT");
    } finally {
      await fixture.cleanup();
    }
  });

  it("preserves the staged index when execution is cancelled after git add", async () => {
    let cancelAfterAdd = true;
    const fixture = await createPreparedLeadFixture({
      afterGitRun(_cwd, argv) {
        if (cancelAfterAdd && argv[0] === "add" && argv[1] === "--all") {
          cancelAfterAdd = false;
          throw new Error("CANCELLED_AFTER_GIT_ADD");
        }
      }
    });
    try {
      await fixture.repository.writeAt(fixture.lead.pathRealpath, "staged.txt", "retain staged content\n");
      await expect(fixture.manager.createCheckpoint({
        projectId: fixture.project.id,
        taskId: fixture.task.id,
        worktree: fixture.lead,
        authorProvider: "claude",
        purpose: "implementation",
        message: "Interrupted checkpoint",
        workerGeneration: GENERATION,
        idempotencyKey: "cancelled-commit",
        checkpointId: "cancelled-commit"
      })).rejects.toThrow("CHECKPOINT_COMMIT_NEEDS_ATTENTION");

      await expect(fixture.git("-C", fixture.lead.pathRealpath, "diff", "--cached", "--name-only"))
        .resolves.toBe("staged.txt");
      await expect(fixture.repository.readAt(fixture.lead.pathRealpath, "staged.txt"))
        .resolves.toBe("retain staged content\n");
      expect(fixture.journal.getByIdempotencyKey("cancelled-commit:commit")?.status)
        .toBe("needs_attention");
      expect(fixture.gitArgvHistory.some(({ argv }) =>
        ["reset", "clean", "stash"].includes(argv[0] ?? "")
        || argv.includes("--force"))).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("retains a checkpoint commit and a raced external ref on immutable-ref conflict", async () => {
    const race: { repository: GitRepositoryFixture | undefined } = { repository: undefined };
    let raceOnce = true;
    const fixture = await createPreparedLeadFixture({
      async afterGitRun(_cwd, argv) {
        if (raceOnce && argv[0] === "commit" && race.repository !== undefined) {
          raceOnce = false;
          await race.repository.run([
            "update-ref",
            "refs/branchestra/checkpoints/raced-checkpoint",
            race.repository.initialOid
          ]);
        }
      }
    });
    race.repository = fixture.repository;
    try {
      await fixture.repository.writeAt(fixture.lead.pathRealpath, "raced.txt", "raced content\n");
      await expect(fixture.manager.createCheckpoint({
        projectId: fixture.project.id,
        taskId: fixture.task.id,
        worktree: fixture.lead,
        authorProvider: "claude",
        purpose: "implementation",
        message: "Raced checkpoint",
        workerGeneration: GENERATION,
        idempotencyKey: "raced-checkpoint",
        checkpointId: "raced-checkpoint"
      })).rejects.toThrow("IMMUTABLE_CHECKPOINT_REF_CONFLICT");

      const retainedHead = await fixture.git("-C", fixture.lead.pathRealpath, "rev-parse", "HEAD");
      expect(retainedHead).not.toBe(fixture.repository.initialOid);
      await expect(fixture.repository.readAt(fixture.lead.pathRealpath, "raced.txt"))
        .resolves.toBe("raced content\n");
      await expect(fixture.git("rev-parse", "refs/branchestra/checkpoints/raced-checkpoint"))
        .resolves.toBe(fixture.repository.initialOid);
      expect(fixture.journal.getByIdempotencyKey("raced-checkpoint:commit")?.status).toBe("completed");
      expect(fixture.journal.getByIdempotencyKey("raced-checkpoint:ref")?.status).toBe("needs_attention");
      expect(fixture.artifacts.getCheckpoint("raced-checkpoint")).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects commit metadata observed from a different HEAD after an external branch race", async () => {
    const race: {
      repository: GitRepositoryFixture | undefined;
      worktreePath: string | undefined;
      branchRef: string | undefined;
      racedOid: string | undefined;
    } = {
      repository: undefined,
      worktreePath: undefined,
      branchRef: undefined,
      racedOid: undefined
    };
    let commitFinished = false;
    let captureOnce = true;
    const fixture = await createPreparedLeadFixture({
      async afterGitRun(_cwd, argv) {
        if (argv[0] === "commit") commitFinished = true;
        if (commitFinished
          && captureOnce
          && argv[0] === "rev-parse"
          && argv[1] === "--verify"
          && argv[2] === "HEAD^{commit}"
          && race.repository !== undefined
          && race.worktreePath !== undefined
          && race.branchRef !== undefined) {
          captureOnce = false;
          const validatedOid = (await race.repository.run(
            ["rev-parse", "HEAD"],
            race.worktreePath
          )).stdout.trim();
          const treeOid = (await race.repository.run(
            ["show", "-s", "--format=%T", validatedOid],
            race.worktreePath
          )).stdout.trim();
          const racedOid = (await race.repository.run([
            "commit-tree",
            treeOid,
            "-p", race.repository.initialOid,
            "-m", "External raced metadata",
            "-m", "Branchestra-Checkpoint-Id: head-metadata-race"
          ])).stdout.trim();
          await race.repository.run(["update-ref", race.branchRef, racedOid]);
          race.racedOid = racedOid;
        }
      }
    });
    race.repository = fixture.repository;
    race.worktreePath = fixture.lead.pathRealpath;
    race.branchRef = fixture.lead.branchRef;
    try {
      await fixture.repository.writeAt(fixture.lead.pathRealpath, "head-race.txt", "head race\n");
      await expect(fixture.manager.createCheckpoint({
        projectId: fixture.project.id,
        taskId: fixture.task.id,
        worktree: fixture.lead,
        authorProvider: "claude",
        purpose: "implementation",
        message: "Observed commit",
        workerGeneration: GENERATION,
        idempotencyKey: "head-metadata-race",
        checkpointId: "head-metadata-race"
      })).rejects.toThrow("CHECKPOINT_COMMIT_NEEDS_ATTENTION");

      expect(race.racedOid).toBeDefined();
      await expect(fixture.git("rev-parse", fixture.lead.branchRef)).resolves.toBe(race.racedOid);
      expect(fixture.journal.getByIdempotencyKey("head-metadata-race:commit")?.status)
        .toBe("needs_attention");
      expect(fixture.journal.getByIdempotencyKey("head-metadata-race:ref")).toBeNull();
      expect(fixture.artifacts.getCheckpoint("head-metadata-race")).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it("atomically persists a checkpoint and pointer, then retries after a fresh manager starts", async () => {
    const fixture = await createPreparedLeadFixture();
    const input = {
      projectId: fixture.project.id,
      taskId: fixture.task.id,
      worktree: fixture.lead,
      authorProvider: "claude" as const,
      purpose: "implementation" as const,
      message: "Atomic persistence",
      workerGeneration: GENERATION,
      idempotencyKey: "atomic-persistence",
      checkpointId: "atomic-persistence"
    };
    try {
      await fixture.repository.writeAt(fixture.lead.pathRealpath, "atomic.txt", "atomic\n");
      fixture.db.exec(`
        CREATE TRIGGER fail_checkpoint_pointer
        BEFORE UPDATE OF current_checkpoint_oid ON worktrees
        BEGIN SELECT RAISE(ABORT, 'POINTER_WRITE_FAILED'); END
      `);

      await expect(fixture.manager.createCheckpoint(input)).rejects.toThrow("POINTER_WRITE_FAILED");
      expect(fixture.artifacts.getCheckpoint(input.checkpointId)).toBeNull();
      expect(fixture.artifacts.getWorktree(fixture.task.id, "lead")?.currentCheckpointOid).toBeNull();

      fixture.db.exec("DROP TRIGGER fail_checkpoint_pointer");
      const restartedManager = fixture.createManager();
      const checkpoint = await restartedManager.createCheckpoint(input);
      expect(fixture.artifacts.getCheckpoint(input.checkpointId)).toEqual(checkpoint);
      expect(fixture.artifacts.getWorktree(fixture.task.id, "lead")?.currentCheckpointOid)
        .toBe(checkpoint.oid);
    } finally {
      fixture.db.exec("DROP TRIGGER IF EXISTS fail_checkpoint_pointer");
      await fixture.cleanup();
    }
  });

  it("marks a post-update-ref observation exception needs_attention while retaining the ref", async () => {
    let refUpdated = false;
    let failObservationOnce = true;
    const fixture = await createPreparedLeadFixture({
      afterGitRun(_cwd, argv) {
        if (argv[0] === "update-ref"
          && argv[1] === "refs/branchestra/checkpoints/ref-observation-failure") {
          refUpdated = true;
          return;
        }
        if (refUpdated
          && failObservationOnce
          && argv[0] === "for-each-ref"
          && argv[argv.length - 1] === "refs/branchestra/checkpoints/ref-observation-failure") {
          failObservationOnce = false;
          throw new Error("POST_UPDATE_REF_OBSERVATION_FAILED");
        }
      }
    });
    try {
      await fixture.repository.writeAt(fixture.lead.pathRealpath, "ref-observe.txt", "retain ref\n");
      await expect(fixture.manager.createCheckpoint({
        projectId: fixture.project.id,
        taskId: fixture.task.id,
        worktree: fixture.lead,
        authorProvider: "claude",
        purpose: "implementation",
        message: "Ref observation failure",
        workerGeneration: GENERATION,
        idempotencyKey: "ref-observation-failure",
        checkpointId: "ref-observation-failure"
      })).rejects.toThrow("CHECKPOINT_REF_NEEDS_ATTENTION");

      expect(refUpdated).toBe(true);
      await expect(fixture.git("rev-parse", "refs/branchestra/checkpoints/ref-observation-failure"))
        .resolves.toMatch(/^[0-9a-f]{40,64}$/);
      expect(fixture.journal.getByIdempotencyKey("ref-observation-failure:ref")?.status)
        .toBe("needs_attention");
      expect(fixture.artifacts.getCheckpoint("ref-observation-failure")).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it("uses full 64-character OIDs and create-only refs in SHA-256 repositories when supported", async () => {
    let fixture: Awaited<ReturnType<typeof createPreparedLeadFixture>>;
    try {
      fixture = await createPreparedLeadFixture({ objectFormat: "sha256" });
    } catch {
      return;
    }
    try {
      await fixture.repository.writeAt(fixture.lead.pathRealpath, "sha256.txt", "sha256\n");
      const checkpoint = await fixture.manager.createCheckpoint({
        projectId: fixture.project.id,
        taskId: fixture.task.id,
        worktree: fixture.lead,
        authorProvider: "codex",
        purpose: "implementation",
        message: "SHA-256 checkpoint",
        workerGeneration: GENERATION,
        idempotencyKey: "sha256-checkpoint",
        checkpointId: "sha256-checkpoint"
      });

      expect(fixture.repository.initialOid).toHaveLength(64);
      expect(checkpoint.oid).toHaveLength(64);
      expect(fixture.gitArgvHistory.some(({ argv }) =>
        argv[0] === "update-ref"
        && argv[1] === checkpoint.immutableRef
        && argv[2] === checkpoint.oid
        && argv[3] === "0".repeat(64))).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });
});
