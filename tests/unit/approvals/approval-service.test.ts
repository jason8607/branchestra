import { describe, expect, it } from "vitest";
import type { ApprovalReceipt, TaskRecord } from "../../../src/shared/contracts/domain";
import { ApprovalService } from "../../../src/worker/approvals/approval-service";
import { canonicalJson, hashCanonical } from "../../../src/worker/approvals/canonical-json";

const decidedAt = "2026-07-24T10:00:00.000Z";
const generation = "50000000-0000-4000-8000-000000000001";
const scope = {
  repositoryRootRealpath: "/repo",
  gitCommonDirRealpath: "/repo/.git",
  writableRootsRealpath: ["/managed/project/task/lead"],
  commandClasses: ["build", "lint", "test"] as Array<"build" | "lint" | "test">,
  allowCollaborator: true,
  toolNetwork: false,
  maxRunMs: 120_000,
  collaborationRoundBudget: 2 as const
};

describe("canonical approval hashing", () => {
  it("sorts object keys while preserving array order and rejecting unsupported values", () => {
    expect(hashCanonical({ beta: 2, alpha: { delta: 4, gamma: 3 } }))
      .toBe(hashCanonical({ alpha: { gamma: 3, delta: 4 }, beta: 2 }));
    expect(hashCanonical({ ...scope, toolNetwork: true })).not.toBe(hashCanonical(scope));
    expect(hashCanonical({ values: ["build", "test"] })).not.toBe(hashCanonical({ values: ["test", "build"] }));

    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, () => undefined, Symbol("x"), 1n]) {
      expect(() => canonicalJson(value)).toThrow("CANONICAL_JSON_UNSUPPORTED");
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => hashCanonical(cyclic)).toThrow("CANONICAL_JSON_CYCLE");
  });
});

describe("ApprovalService", () => {
  it("lets approved task-scope receipts survive generation changes", () => {
    const service = new ApprovalService();
    const receipt = service.createReceipt({
      id: "receipt-1",
      requestId: "request-1",
      taskId: "task-1",
      kind: "task_scope",
      decision: "approved",
      scope,
      workerGeneration: generation,
      decidedAt
    });
    expect(receipt.survivesWorkerRestart).toBe(true);
    expect(service.assertTaskCapability(receipt, "50000000-0000-4000-8000-000000000002")).toEqual(scope);
    expect(() => service.assertTaskCapability({
      ...receipt,
      survivesWorkerRestart: false
    }, generation)).toThrow("TASK_CAPABILITY_RECEIPT_INVALID");
  });

  it.each(["additional_round", "external_operation", "final_merge"] as const)(
    "does not let %s receipts survive generation changes",
    (kind) => {
      const service = new ApprovalService();
      const scopes = {
        additional_round: { additionalRounds: 1 as const },
        external_operation: { operation: "network.fetch" },
        final_merge: {
          targetRef: "refs/heads/main",
          baseOid: "a".repeat(40),
          candidateOid: "b".repeat(40),
          diffHash: "sha256:diff" as const,
          testSetHash: "sha256:tests" as const
        }
      };
      const receipt = service.createReceipt({
        id: `receipt-${kind}`,
        requestId: `request-${kind}`,
        taskId: "task-1",
        kind,
        decision: "approved",
        scope: scopes[kind],
        workerGeneration: generation,
        decidedAt
      } as Parameters<ApprovalService["createReceipt"]>[0]);
      expect(receipt.survivesWorkerRestart).toBe(false);
      expect(() => service.assertTaskCapability(receipt, generation)).toThrow("TASK_CAPABILITY_RECEIPT_REQUIRED");
    }
  );

  it.each([
    ["rejected", generation, "TASK_CAPABILITY_NOT_APPROVED"],
    ["approved", "50000000-0000-4000-8000-000000000002", null]
  ] as const)("denies invalid task capabilities", (decision, currentGeneration, error) => {
    const service = new ApprovalService();
    const receipt = service.createReceipt({
      id: "receipt-1",
      requestId: "request-1",
      taskId: "task-1",
      kind: "task_scope",
      decision,
      scope,
      workerGeneration: generation,
      decidedAt
    });
    if (error === null) expect(service.assertTaskCapability(receipt, currentGeneration)).toEqual(scope);
    else expect(() => service.assertTaskCapability(receipt, currentGeneration)).toThrow(error);
  });

  it("requires a newly approved receipt before granting additional rounds", () => {
    const task = {
      id: "task-1",
      state: "HumanApproval",
      collaborationRoundBudget: 2,
      version: 4
    } as TaskRecord;
    const rejected = {
      id: "receipt-rejected",
      requestId: "request-round",
      taskId: task.id,
      kind: "additional_round",
      decision: "rejected",
      scope: { additionalRounds: 1 },
      scopeHash: "sha256:round",
      workerGeneration: generation,
      survivesWorkerRestart: false,
      decidedAt
    } as ApprovalReceipt;
    const service = new ApprovalService({
      approvals: { getRequired: () => rejected }
    });
    expect(() => service.grantAdditionalRounds({
      task,
      receiptId: rejected.id,
      additionalRounds: 1,
      workerGeneration: generation,
      decidedAt,
      idempotencyKey: "round-1"
    })).toThrow("ADDITIONAL_ROUND_NOT_APPROVED");
  });
});
