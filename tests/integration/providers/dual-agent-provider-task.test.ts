import { describe, expect, it } from "vitest";
import { createDualAgentProviderHarness } from "../../helpers/dual-agent-provider-harness";

describe("two-Agent Provider Adapter vertical slice", { timeout: 180_000 }, () => {
  it("runs Claude lead, Codex reviews, and Claude revision without MockProvider", async () => {
    const harness = await createDualAgentProviderHarness();
    try {
      await harness.runUntilCandidate();

      expect(harness.runner.adaptersUsed).toEqual(["claude", "codex", "claude", "codex"]);
      expect(harness.fixture.artifacts.listWorktrees("task-1").map(({ role }) => role).sort())
        .toEqual(["collaborator", "lead"]);
      const codexReview = harness.runner.commands.find(({ provider }) => provider === "codex");
      expect(codexReview?.request.instruction).toContain("immutableLeadCheckpointOid");
      const claudeRevision = harness.runner.commands.filter(({ provider }) => provider === "claude")[1];
      expect(claudeRevision?.request.instruction).toContain("address the review");
      expect(harness.fixture.tasks.listRuns("task-1").map(({ providerSessionId }) => providerSessionId))
        .toEqual(["claude-session-1", "codex-thread-2", "claude-session-3", "codex-thread-4"]);
      expect(harness.fixture.databaseFixture.db.prepare(
        "SELECT COUNT(*) AS count FROM provider_events"
      ).get()).toEqual({ count: 12 });
      expect(harness.fixture.databaseFixture.db.prepare(
        "SELECT COUNT(*) AS count FROM context_bundles"
      ).get()).toEqual({ count: 4 });
      expect(harness.runner.commands.every(({ request }) =>
        request.instruction.startsWith("READ-ONLY BRANCHESTRA CONTEXT\n")
      )).toBe(true);
      expect(harness.fixture.events.types()).toEqual(expect.arrayContaining([
        "agent.run", "checkpoint.created", "review.started", "review.completed", "candidate.created"
      ]));
      expect(harness.fixture.tasks.getRequired("task-1").state).toBe("HumanApproval");
    } finally {
      await harness.cleanup();
    }
  });
});
