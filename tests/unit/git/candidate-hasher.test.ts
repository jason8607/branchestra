import { describe, expect, it } from "vitest";
import type { TestResultRecord } from "../../../src/shared/contracts/domain";
import { CandidateHasher } from "../../../src/worker/git/candidate-hasher";

function testResult(overrides: Partial<TestResultRecord> = {}): TestResultRecord {
  return {
    id: "result-a",
    taskId: "task-1",
    candidateId: "candidate-1",
    commandId: "a",
    executableRealpath: "/usr/bin/true",
    argv: ["--version"],
    exitCode: 0,
    stdoutHash: `sha256:${"a".repeat(64)}`,
    stderrHash: `sha256:${"b".repeat(64)}`,
    durationMs: 10,
    logReference: "room-event:event-1",
    createdAt: "2026-07-31T00:00:00.000Z",
    ...overrides
  };
}

describe("CandidateHasher", () => {
  it("hashes raw diff bytes", () => {
    const hasher = new CandidateHasher();
    expect(hasher.diffHash(Buffer.from([0, 255, 10]))).toBe(
      "sha256:712450d3c4a79eea9509e75dc1dacdeff58034df538536cfae2da882bd8a0c50"
    );
  });

  it("hashes only the normalized, command-ordered test set", () => {
    const hasher = new CandidateHasher();
    const a = testResult();
    const b = testResult({ id: "result-b", commandId: "b", exitCode: 1 });

    expect(hasher.testSetHash([b, a])).toBe(hasher.testSetHash([a, b]));
    expect(hasher.testSetHash([a, b])).not.toBe(
      hasher.testSetHash([a, testResult({ id: "result-b", commandId: "b", exitCode: 0 })])
    );
    expect(hasher.testSetHash([a])).toBe(hasher.testSetHash([
      { ...a, id: "other", durationMs: 999, logReference: "room-event:other", createdAt: "2027-01-01T00:00:00.000Z" }
    ]));
  });
});
