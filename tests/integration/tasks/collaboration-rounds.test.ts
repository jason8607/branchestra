import { describe, expect, it } from "vitest";
import { createCollaborationFixture } from "../../fixtures/task-engine";

describe("two-round collaboration", { timeout: 180_000 }, () => {
  it("runs exactly two automatic rounds against immutable checkpoint OIDs", async () => {
    const fixture = await createCollaborationFixture();
    try {
      await fixture.engine.startApprovedTask("task-1", "start-lead");
      const firstLeadCheckpoint = fixture.latestCheckpoint("lead");
      await fixture.collaboration.requestRound({
        taskId: "task-1",
        purpose: "review",
        idempotencyKey: "round-1"
      });
      expect(fixture.tasks.getRequired("task-1")).toMatchObject({
        state: "Review1",
        collaborationRoundsUsed: 1
      });
      expect(fixture.mock.lastRequest("codex")).toMatchObject({
        checkpointOid: firstLeadCheckpoint.oid,
        role: "reviewer"
      });
      expect(fixture.mock.lastRequest("codex").worktreePath)
        .not.toBe(fixture.artifacts.getWorktree("task-1", "lead")?.pathRealpath);

      await fixture.collaboration.completeReview({
        taskId: "task-1",
        findings: ["rename symbol"],
        idempotencyKey: "review-1"
      });
      await fixture.runLeadRevision();
      const revisionCheckpoint = fixture.latestCheckpoint("lead");
      await fixture.collaboration.requestRound({
        taskId: "task-1",
        purpose: "review",
        idempotencyKey: "round-2"
      });
      expect(fixture.tasks.getRequired("task-1")).toMatchObject({
        state: "Review2",
        collaborationRoundsUsed: 2
      });
      expect(fixture.mock.lastRequest("codex").checkpointOid).toBe(revisionCheckpoint.oid);
      await expect(fixture.collaboration.requestRound({
        taskId: "task-1",
        purpose: "review",
        idempotencyKey: "round-3"
      })).rejects.toThrow("COLLABORATION_ROUND_BUDGET_EXHAUSTED");
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not spend a round for a human-directed revision", async () => {
    const fixture = await createCollaborationFixture({
      state: "HumanApproval",
      roundsUsed: 2
    });
    try {
      await fixture.requestHumanRevision("change copy");
      expect(fixture.tasks.getRequired("task-1")).toMatchObject({
        state: "Revision",
        collaborationRoundsUsed: 2,
        humanRevisionCount: 1,
        revisionKind: "human_directed"
      });
      await expect(fixture.collaboration.requestRound({
        taskId: "task-1",
        purpose: "review",
        idempotencyKey: "human-round"
      })).rejects.toThrow("COLLABORATION_ROUND_BUDGET_EXHAUSTED");
      await fixture.grantAdditionalRound(1);
      await expect(fixture.collaboration.requestRound({
        taskId: "task-1",
        purpose: "review",
        idempotencyKey: "granted-round"
      })).resolves.toMatchObject({
        collaborationRoundsUsed: 3,
        collaborationRoundBudget: 3
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("requires collaborator approval and coalesces only the same in-flight request", async () => {
    const denied = await createCollaborationFixture({ allowCollaborator: false });
    try {
      await denied.engine.startApprovedTask("task-1", "start-denied-lead");
      await expect(denied.collaboration.requestRound({
        taskId: "task-1",
        purpose: "review",
        idempotencyKey: "denied"
      })).rejects.toThrow("COLLABORATOR_NOT_APPROVED");
    } finally {
      await denied.cleanup();
    }

    const fixture = await createCollaborationFixture();
    try {
      await fixture.engine.startApprovedTask("task-1", "start-concurrent-lead");
      const input = {
        taskId: "task-1",
        purpose: "review" as const,
        idempotencyKey: "same-round"
      };
      const [first, replay] = await Promise.all([
        fixture.collaboration.requestRound(input),
        fixture.collaboration.requestRound(input)
      ]);
      expect(replay).toEqual(first);
      expect(fixture.tasks.getRequired("task-1").collaborationRoundsUsed).toBe(1);
      expect(fixture.mock.requests().filter(({ role }) => role === "reviewer")).toHaveLength(1);
      await expect(fixture.collaboration.requestRound({
        ...input,
        idempotencyKey: "different-round"
      })).rejects.toThrow("ILLEGAL_TRANSITION:Review1:beginReview");
    } finally {
      await fixture.cleanup();
    }

    const conflicting = await createCollaborationFixture();
    try {
      await conflicting.engine.startApprovedTask("task-1", "start-key-conflict-lead");
      const [first, second] = await Promise.allSettled([
        conflicting.collaboration.requestRound({
          taskId: "task-1",
          purpose: "review",
          idempotencyKey: "shared-key"
        }),
        conflicting.collaboration.requestRound({
          taskId: "task-1",
          purpose: "parallel_implementation",
          idempotencyKey: "shared-key"
        })
      ]);
      expect(first.status).toBe("fulfilled");
      expect(second).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({
          message: expect.stringContaining("ENGINE_IDEMPOTENCY_KEY_CONFLICT:shared-key")
        })
      });
    } finally {
      await conflicting.cleanup();
    }
  });

  it("keeps review output read-only and checkpoints parallel implementation from the recorded base", async () => {
    const reviewer = await createCollaborationFixture({ reviewerWrites: true });
    try {
      await reviewer.engine.startApprovedTask("task-1", "start-review-lead");
      await expect(reviewer.collaboration.requestRound({
        taskId: "task-1",
        purpose: "review",
        idempotencyKey: "read-only-review"
      })).rejects.toThrow("REVIEWER_WORKSPACE_MUTATION_FORBIDDEN");
      expect(await reviewer.leadPathExists("forbidden.txt")).toBe(false);
    } finally {
      await reviewer.cleanup();
    }

    const collaborator = await createCollaborationFixture({ parallelImplementation: true });
    try {
      await collaborator.engine.startApprovedTask("task-1", "start-parallel-lead");
      const leadCheckpoint = collaborator.latestCheckpoint("lead");
      await collaborator.collaboration.requestRound({
        taskId: "task-1",
        purpose: "parallel_implementation",
        idempotencyKey: "parallel-round"
      });
      const alternative = collaborator.latestCheckpoint("collaborator");
      const collaboratorWorktree = collaborator.artifacts.getWorktree(
        "task-1",
        "collaborator"
      )!;
      expect(alternative.oid).not.toBe(leadCheckpoint.oid);
      expect((await collaborator.repository.run(
        ["show", "-s", "--format=%P", alternative.oid],
        collaboratorWorktree.pathRealpath
      )).stdout.trim()).toBe(collaboratorWorktree.baseOid);
      expect(collaborator.events.byType("checkpoint.created").at(-1)?.payload)
        .toEqual({ checkpoint: alternative });
      expect(collaborator.mock.lastRequest("codex").approvedCapabilities)
        .not.toHaveProperty("git");
      expect(await collaborator.repository.readAt(
        collaborator.artifacts.getWorktree("task-1", "collaborator")!.pathRealpath,
        "alternative.txt"
      )).toBe("alternative\n");
      expect(await collaborator.leadPathExists("alternative.txt")).toBe(false);
    } finally {
      await collaborator.cleanup();
    }
  });

  it("uses TaskEngine cancellation to stop a reviewer before any later side effect", async () => {
    const fixture = await createCollaborationFixture({
      reviewerWaitsForCancel: true
    });
    let round: Promise<unknown> | undefined;
    try {
      await fixture.engine.startApprovedTask("task-1", "start-cancel-lead");
      round = fixture.collaboration.requestRound({
        taskId: "task-1",
        purpose: "review",
        idempotencyKey: "cancelled-review"
      });
      await fixture.mock.waitUntilBlocked();
      await expect(fixture.engine.cancel(
        "task-1",
        "user",
        "cancel-review"
      )).resolves.toMatchObject({ state: "Cancelled" });
      const settled = await Promise.race([
        round.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 250))
      ]);
      expect(settled).toBe(true);
      expect(fixture.tasks.listRuns("task-1").at(-1)?.state).toBe("cancelled");
      expect(fixture.latestCheckpoint("lead").authorProvider).toBe("claude");
    } finally {
      await fixture.mock.cancelLastRun();
      await round?.catch(() => undefined);
      await fixture.cleanup();
    }
  });

  it("enforces the approved maxRunMs deadline for reviewer runs", async () => {
    const fixture = await createCollaborationFixture({
      reviewerWaitsForCancel: true,
      maxRunMs: 25
    });
    let round: Promise<unknown> | undefined;
    try {
      await fixture.engine.startApprovedTask("task-1", "start-timeout-lead");
      round = fixture.collaboration.requestRound({
        taskId: "task-1",
        purpose: "review",
        idempotencyKey: "timed-review"
      });
      await fixture.mock.waitUntilBlocked();
      const result = await Promise.race([
        round,
        new Promise<"deadline-missed">((resolve) => {
          setTimeout(() => resolve("deadline-missed"), 300);
        })
      ]);
      expect(result).not.toBe("deadline-missed");
      expect(fixture.tasks.getRequired("task-1").state).toBe("Cancelled");
    } finally {
      await fixture.mock.cancelLastRun();
      await round?.catch(() => undefined);
      await fixture.cleanup();
    }
  });

  it("uses durable round context even when the room contains more than one event page", async () => {
    const fixture = await createCollaborationFixture();
    try {
      await fixture.engine.startApprovedTask("task-1", "start-paged-lead");
      fixture.appendNoiseEvents(501);
      await fixture.collaboration.requestRound({
        taskId: "task-1",
        purpose: "review",
        idempotencyKey: "paged-round"
      });
      await expect(fixture.collaboration.completeReview({
        taskId: "task-1",
        findings: ["paged finding"],
        idempotencyKey: "paged-review"
      })).resolves.toMatchObject({ state: "Revision" });
    } finally {
      await fixture.cleanup();
    }
  });

  it("atomically commits the review transition, completion marker, and event", async () => {
    const fixture = await createCollaborationFixture();
    try {
      await fixture.engine.startApprovedTask("task-1", "start-atomic-lead");
      await fixture.collaboration.requestRound({
        taskId: "task-1",
        purpose: "review",
        idempotencyKey: "atomic-round"
      });
      fixture.databaseFixture.db.exec(`
        CREATE TRIGGER reject_review_completed
        BEFORE INSERT ON room_events
        WHEN NEW.event_type = 'review.completed'
        BEGIN
          SELECT RAISE(ABORT, 'REVIEW_EVENT_REJECTED');
        END;
      `);
      await expect(fixture.collaboration.completeReview({
        taskId: "task-1",
        findings: ["must roll back"],
        idempotencyKey: "atomic-review"
      })).rejects.toThrow();
      expect(fixture.tasks.getRequired("task-1").state).toBe("Review1");
    } finally {
      await fixture.cleanup();
    }
  });

  it("durably completes round two once across idempotency keys", async () => {
    const fixture = await createCollaborationFixture();
    try {
      await fixture.engine.startApprovedTask("task-1", "start-once-lead");
      await fixture.collaboration.requestRound({
        taskId: "task-1",
        purpose: "review",
        idempotencyKey: "once-round-1"
      });
      await fixture.collaboration.completeReview({
        taskId: "task-1",
        findings: ["round one"],
        idempotencyKey: "once-review-1"
      });
      await fixture.runLeadRevision();
      await fixture.collaboration.requestRound({
        taskId: "task-1",
        purpose: "review",
        idempotencyKey: "once-round-2"
      });
      const first = await fixture.collaboration.completeReview({
        taskId: "task-1",
        findings: ["same disagreement"],
        idempotencyKey: "once-review-2"
      });
      await expect(fixture.collaboration.completeReview({
        taskId: "task-1",
        findings: ["same disagreement"],
        idempotencyKey: "same-review-new-key"
      })).resolves.toEqual(first);
      await expect(fixture.collaboration.completeReview({
        taskId: "task-1",
        findings: ["different disagreement"],
        idempotencyKey: "conflicting-review-new-key"
      })).rejects.toThrow("REVIEW_ROUND_ALREADY_COMPLETED");
      expect(fixture.events.byType("review.completed")
        .filter(({ payload }) => payload.round === 2)).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("durably retains unresolved round-two findings instead of treating disagreement as success", async () => {
    const fixture = await createCollaborationFixture();
    try {
      await fixture.engine.startApprovedTask("task-1", "start-divergence-lead");
      await fixture.collaboration.requestRound({
        taskId: "task-1",
        purpose: "review",
        idempotencyKey: "divergence-round-1"
      });
      await fixture.collaboration.completeReview({
        taskId: "task-1",
        findings: ["first issue"],
        idempotencyKey: "divergence-review-1"
      });
      await fixture.runLeadRevision();
      await fixture.collaboration.requestRound({
        taskId: "task-1",
        purpose: "review",
        idempotencyKey: "divergence-round-2"
      });
      const reviewedOid = fixture.latestCheckpoint("lead").oid;
      const result = await fixture.collaboration.completeReview({
        taskId: "task-1",
        findings: ["agents still disagree"],
        idempotencyKey: "divergence-review-2"
      });
      expect(result.state).toBe("Review2");
      expect(fixture.events.byType("review.completed").at(-1)?.payload).toMatchObject({
        taskId: "task-1",
        checkpointOid: reviewedOid,
        findings: ["agents still disagree"]
      });
    } finally {
      await fixture.cleanup();
    }
  });
});
