import { describe, expect, it, vi } from "vitest";
import type {
  OperationIntentRecord,
  OperationRecord,
  OperationStatus,
  RecordIntentResult
} from "../../../src/worker/operations/operation-journal";
import { JournaledOperationRunner } from "../../../src/worker/operations/journaled-operation-runner";

type Expected = { ref: string };
type Observation = { outcome: string; actual: Record<string, unknown>; result?: string };

interface InMemoryOperationJournal {
  recordIntent<E>(record: OperationIntentRecord<E>): RecordIntentResult<E>;
  markExecuting(id: string): void;
  recordObservation<O>(id: string, observation: O): void;
  complete(id: string): void;
  needsAttention(id: string, observation: Record<string, unknown>): void;
  getByIdempotencyKey(key: string): OperationRecord<Expected, Observation> | null;
}

function operationIntent(id: string): OperationIntentRecord<Expected> {
  return {
    id,
    projectId: "project-1",
    taskId: "task-1",
    repositoryCommonDirRealpath: "/repos/example/.git",
    operationType: "update_ref",
    idempotencyKey: `idem-${id}`,
    expected: { ref: "refs/heads/main" },
    status: "intent",
    observation: null,
    workerGeneration: "generation-1",
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z"
  };
}

function inMemoryOperationJournal(): InMemoryOperationJournal {
  const records = new Map<string, OperationRecord<Expected, Observation>>();
  const requireRecord = (id: string) => {
    const record = [...records.values()].find((candidate) => candidate.id === id);
    if (!record) throw new Error(`OPERATION_NOT_FOUND:${id}`);
    return record;
  };
  const assertStatus = (record: OperationRecord, expected: OperationStatus[]) => {
    if (!expected.includes(record.status)) {
      throw new Error(`OPERATION_STATUS_PRECONDITION:${record.id}:${expected.join("|")}:${record.status}`);
    }
  };

  return {
    recordIntent<E>(record: OperationIntentRecord<E>): RecordIntentResult<E> {
      if (record.status !== "intent") throw new Error("OPERATION_INTENT_STATUS_REQUIRED");
      if (record.observation !== null) throw new Error("OPERATION_INTENT_OBSERVATION_MUST_BE_NULL");
      const existing = records.get(record.idempotencyKey);
      if (existing) {
        if (JSON.stringify(existing.expected) !== JSON.stringify(record.expected)) {
          throw new Error("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INTENT");
        }
        return { record: existing as unknown as OperationRecord<E, never>, created: false };
      }
      const durable = { ...record } as unknown as OperationRecord<Expected, Observation>;
      records.set(record.idempotencyKey, durable);
      return { record: durable as unknown as OperationRecord<E, never>, created: true };
    },
    markExecuting(id) {
      const record = requireRecord(id);
      assertStatus(record, ["intent"]);
      record.status = "executing";
    },
    recordObservation(id, observation) {
      const record = requireRecord(id);
      assertStatus(record, ["executing"]);
      record.status = "observed";
      record.observation = observation as Observation;
    },
    complete(id) {
      const record = requireRecord(id);
      assertStatus(record, ["observed"]);
      record.status = "completed";
    },
    needsAttention(id, observation) {
      const record = requireRecord(id);
      if (record.status === "completed") throw new Error(`OPERATION_ALREADY_COMPLETED:${id}`);
      record.status = "needs_attention";
      record.observation = observation as Observation;
    },
    getByIdempotencyKey(key) {
      return records.get(key) ?? null;
    }
  };
}

describe("JournaledOperationRunner", () => {
  it("records intent before execute and completes only after an applied observation", async () => {
    const calls: string[] = [];
    const journal = inMemoryOperationJournal();
    const runner = new JournaledOperationRunner({
      recordIntent: (record) => { calls.push("intent"); return journal.recordIntent(record); },
      markExecuting: (id) => { calls.push("executing"); journal.markExecuting(id); },
      recordObservation: (id, observation) => { calls.push("observed"); journal.recordObservation(id, observation); },
      complete: (id) => { calls.push("completed"); journal.complete(id); },
      needsAttention: (id, observation) => { calls.push("needs_attention"); journal.needsAttention(id, observation); }
    });

    const result = await runner.run({
      intent: operationIntent("op-1"),
      execute: async () => { calls.push("execute"); },
      observe: async () => {
        calls.push("observe");
        return { outcome: "applied" as const, actual: { oid: "b".repeat(40) }, result: "ok" };
      }
    });

    expect(result).toBe("ok");
    expect(calls).toEqual(["intent", "executing", "execute", "observe", "observed", "completed"]);
  });

  it("returns the persisted result from a completed applied operation without executing again", async () => {
    const journal = inMemoryOperationJournal();
    const intent = operationIntent("already-completed");
    journal.recordIntent(intent);
    journal.markExecuting(intent.id);
    journal.recordObservation(intent.id, { outcome: "applied", actual: { oid: "a" }, result: "prior-result" });
    journal.complete(intent.id);
    const execute = vi.fn(async () => undefined);
    const observe = vi.fn(async () => ({ outcome: "applied" as const, actual: { oid: "b" }, result: "new-result" }));

    await expect(new JournaledOperationRunner(journal).run({ intent, execute, observe })).resolves.toBe("prior-result");
    expect(execute).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });

  it.each([
    { outcome: "applied", actual: { oid: "a" } },
    { outcome: "not_applied", actual: { oid: "a" } }
  ])("refuses to replay a completed operation without a persisted applied result", async (observation) => {
    const journal = inMemoryOperationJournal();
    const intent = operationIntent(`completed-${observation.outcome}`);
    journal.recordIntent(intent);
    journal.markExecuting(intent.id);
    journal.recordObservation(intent.id, observation);
    journal.complete(intent.id);
    const execute = vi.fn(async () => undefined);

    await expect(new JournaledOperationRunner(journal).run({
      intent,
      execute,
      observe: async () => ({ outcome: "applied" as const, actual: {}, result: "unexpected" })
    })).rejects.toThrow(`OPERATION_REQUIRES_RECONCILIATION:${intent.id}`);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses to replay a completed operation whose canonical intent differs", async () => {
    const journal = inMemoryOperationJournal();
    const intent = operationIntent("completed-different-intent");
    journal.recordIntent(intent);
    journal.markExecuting(intent.id);
    journal.recordObservation(intent.id, { outcome: "applied", actual: {}, result: "prior-result" });
    journal.complete(intent.id);
    const execute = vi.fn(async () => undefined);

    await expect(new JournaledOperationRunner(journal).run({
      intent: { ...intent, expected: { ref: "refs/heads/other" } },
      execute,
      observe: async () => ({ outcome: "applied" as const, actual: {}, result: "unexpected" })
    })).rejects.toThrow("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INTENT");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["intent", "executing", "observed", "needs_attention"] as const)(
    "refuses to automatically execute an existing %s operation",
    async (status) => {
      const journal = inMemoryOperationJournal();
      const intent = operationIntent(`existing-${status}`);
      journal.recordIntent(intent);
      if (status === "executing" || status === "observed") journal.markExecuting(intent.id);
      if (status === "observed") journal.recordObservation(intent.id, { outcome: "not_applied", actual: {} });
      if (status === "needs_attention") journal.needsAttention(intent.id, { outcome: "uncertain", actual: {} });
      const execute = vi.fn(async () => undefined);
      const observe = vi.fn(async () => ({ outcome: "applied" as const, actual: {}, result: "unexpected" }));

      await expect(new JournaledOperationRunner(journal).run({ intent, execute, observe }))
        .rejects.toThrow(`OPERATION_REQUIRES_RECONCILIATION:${intent.id}`);
      expect(execute).not.toHaveBeenCalled();
      expect(observe).not.toHaveBeenCalled();
    }
  );

  it.each(["not_applied", "conflict", "uncertain"] as const)(
    "marks a %s observation for attention",
    async (outcome) => {
      const journal = inMemoryOperationJournal();
      const intent = operationIntent(`op-${outcome}`);
      await expect(new JournaledOperationRunner(journal).run({
        intent,
        execute: async () => undefined,
        observe: async () => ({ outcome, actual: { ref: "changed externally" } })
      })).rejects.toThrow(`OPERATION_${outcome.toUpperCase()}:${intent.id}`);
      expect(journal.getByIdempotencyKey(intent.idempotencyKey)?.status).toBe("needs_attention");
    }
  );

  it("retains executing state when execute throws", async () => {
    const journal = inMemoryOperationJournal();
    const intent = operationIntent("execute-throws");
    const observe = vi.fn(async () => ({ outcome: "applied" as const, actual: {}, result: "unused" }));

    await expect(new JournaledOperationRunner(journal).run({
      intent,
      execute: async () => { throw new Error("git failed"); },
      observe
    })).rejects.toThrow("git failed");
    expect(journal.getByIdempotencyKey(intent.idempotencyKey)?.status).toBe("executing");
    expect(observe).not.toHaveBeenCalled();
  });

  it("durably marks an observation exception uncertain while preserving the error", async () => {
    const journal = inMemoryOperationJournal();
    const intent = operationIntent("observe-throws");

    await expect(new JournaledOperationRunner(journal).run({
      intent,
      execute: async () => undefined,
      observe: async () => { throw new Error("observation failed"); }
    })).rejects.toThrow("observation failed");
    expect(journal.getByIdempotencyKey(intent.idempotencyKey)).toMatchObject({
      status: "needs_attention",
      observation: {
        outcome: "uncertain",
        actual: { error: "Error:observation failed" }
      }
    });
  });
});
