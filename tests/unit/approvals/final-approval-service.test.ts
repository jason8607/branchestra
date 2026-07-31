import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { FinalApprovalTuple } from "../../../src/shared/contracts/domain";
import { FinalApprovalService } from "../../../src/worker/approvals/final-approval-service";
import { createEventStore } from "../../../src/worker/storage/event-store";
import { createRepositories } from "../../../src/worker/storage/repositories";
import { openTestDatabase } from "../../fixtures/test-database";
import { rmSync } from "node:fs";

const directories: string[] = [];
const generation = "50000000-0000-4000-8000-000000000001";
const original: FinalApprovalTuple = {
  targetRef: "refs/heads/main",
  baseOid: "a".repeat(40),
  candidateOid: "b".repeat(40),
  diffHash: `sha256:${"c".repeat(64)}`,
  testSetHash: `sha256:${"d".repeat(64)}`
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function finalApprovalFixture() {
  const testDb = openTestDatabase();
  directories.push(testDb.directory);
  const repositories = createRepositories(testDb.db);
  repositories.tasks.insert({
    ...testDb.records.task,
    state: "HumanApproval",
    scopeApprovalId: "scope-approval",
    activeCandidateId: "candidate-1"
  });
  let current = original;
  const service = new FinalApprovalService({
    tasks: repositories.tasks,
    approvals: repositories.approvals,
    events: createEventStore(testDb.db, repositories),
    tupleSource: { current: async () => current },
    candidates: {
      get: () => ({
        ...testDb.records.candidate,
        taskId: testDb.records.task.id,
        candidateOid: current.candidateOid,
        targetRef: current.targetRef,
        baseOid: current.baseOid,
        diffHash: current.diffHash,
        testSetHash: current.testSetHash
      })
    },
    workerGeneration: generation,
    id: randomUUID,
    now: () => new Date().toISOString()
  });
  return {
    service,
    tasks: repositories.tasks,
    setCurrent(tuple: FinalApprovalTuple) {
      current = tuple;
    },
    async approve(displayed: FinalApprovalTuple) {
      const request = await service.request(testDb.records.task.id, "request-final");
      return service.approve({
        taskId: testDb.records.task.id,
        approvalRequestId: request.id,
        displayed,
        workerGeneration: generation,
        idempotencyKey: "approve-final"
      });
    },
    close: () => testDb.db.close()
  };
}

describe("FinalApprovalService", () => {
  it.each([
    ["targetRef", "FINAL_APPROVAL_TARGET_REF_MISMATCH", "refs/heads/other"],
    ["baseOid", "FINAL_APPROVAL_BASE_OID_MISMATCH", "e".repeat(40)],
    ["candidateOid", "FINAL_APPROVAL_CANDIDATE_OID_MISMATCH", "e".repeat(40)],
    ["diffHash", "FINAL_APPROVAL_DIFF_HASH_MISMATCH", `sha256:${"e".repeat(64)}`],
    ["testSetHash", "FINAL_APPROVAL_TEST_SET_HASH_MISMATCH", `sha256:${"e".repeat(64)}`]
  ] as const)("invalidates when %s changes", async (field, code, changed) => {
    const fixture = finalApprovalFixture();
    try {
      const receipt = await fixture.approve(original);
      fixture.setCurrent({ ...original, [field]: changed });
      await expect(fixture.service.assertCurrentlyValid(receipt.id, generation)).rejects.toThrow(code);
      expect(fixture.tasks.getRequired("task-1").state).toBe("HumanApproval");
    } finally {
      fixture.close();
    }
  });

  it("creates one exact immutable receipt and accepts duplicate approval replay", async () => {
    const fixture = finalApprovalFixture();
    try {
      const receipt = await fixture.approve(original);
      const request = { taskId: "task-1", approvalRequestId: receipt.requestId, displayed: original, workerGeneration: generation, idempotencyKey: "approve-final" };
      await expect(fixture.service.approve(request)).resolves.toEqual(receipt);
      await expect(fixture.service.assertCurrentlyValid(receipt.id, generation))
        .resolves.toMatchObject({ receipt, task: { state: "Merging" } });
    } finally {
      fixture.close();
    }
  });
});
