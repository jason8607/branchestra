import { describe, expect, it } from "vitest";
import { createCollaborationFixture } from "../../fixtures/task-engine";

describe("two-round collaboration", { timeout: 60_000 }, () => {
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
      expect(alternative.oid).not.toBe(leadCheckpoint.oid);
      expect(collaborator.events.byType("checkpoint.created").at(-1)?.payload)
        .toEqual({ checkpoint: alternative });
      expect(await collaborator.repository.readAt(
        collaborator.artifacts.getWorktree("task-1", "collaborator")!.pathRealpath,
        "alternative.txt"
      )).toBe("alternative\n");
      expect(await collaborator.leadPathExists("alternative.txt")).toBe(false);
    } finally {
      await collaborator.cleanup();
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
