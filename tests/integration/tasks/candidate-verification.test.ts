import { describe, expect, it } from "vitest";
import { createCandidateFixture } from "../../fixtures/task-engine";

describe("verified integration candidates", () => {
  it("binds an immutable candidate ref to raw diff bytes and the executed test set", async () => {
    const fixture = await createCandidateFixture();
    try {
      const candidate = await fixture.candidates.buildVerifiedCandidate({
        taskId: "task-1",
        selectedCheckpointIds: [fixture.checkpoint.id],
        testCommandIds: ["unit"],
        unresolved: [],
        workerGeneration: fixture.generation,
        idempotencyKey: "candidate-1"
      });

      expect(candidate.immutableRef).toBe(`refs/branchestra/candidates/${candidate.id}`);
      expect(await fixture.git("rev-parse", candidate.immutableRef)).toBe(candidate.candidateOid);
      expect(candidate.diffHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(candidate.testSetHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(candidate.diffSummary).toMatchObject({
        filesChanged: 1,
        additions: 1,
        deletions: 0
      });
      expect(candidate.testResults).toEqual([
        expect.objectContaining({ commandId: "unit", exitCode: 0 })
      ]);
      expect(fixture.artifacts.getCandidate(candidate.id)).toEqual(candidate);
      expect(fixture.tasks.getRequired("task-1")).toMatchObject({
        state: "HumanApproval",
        activeCandidateId: candidate.id
      });
      expect(fixture.events.types()).toEqual(expect.arrayContaining([
        "test.completed",
        "candidate.created"
      ]));
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects an unregistered command before creating a candidate ref or process intent", async () => {
    const fixture = await createCandidateFixture();
    try {
      await expect(fixture.candidates.buildVerifiedCandidate({
        taskId: "task-1",
        selectedCheckpointIds: [fixture.checkpoint.id],
        testCommandIds: ["unknown"],
        unresolved: [],
        workerGeneration: fixture.generation,
        idempotencyKey: "candidate-unknown-command"
      })).rejects.toThrow("PROJECT_COMMAND_NOT_REGISTERED:unknown");

      expect(await fixture.git("for-each-ref", "--format=%(refname)", "refs/branchestra/candidates/"))
        .toBe("");
      expect(fixture.repositories.operations.listIncomplete()).toEqual([]);
      expect(fixture.tasks.getRequired("task-1").state).toBe("Review2");
    } finally {
      await fixture.cleanup();
    }
  });
});
