import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { parseWorkerEnvironment } from "../../src/worker/entry-environment";

const valid = {
  BRANCHESTRA_DB_PATH: " /tmp/branchestra.sqlite3 ",
  BRANCHESTRA_OWNER_INSTANCE_ID: "60000000-0000-4000-8000-000000000001",
  BRANCHESTRA_WORKER_GENERATION: "50000000-0000-4000-8000-000000000001",
  BRANCHESTRA_WORKER_START_IDENTITY: "40000000-0000-4000-8000-000000000001"
};

describe("worker entry environment", () => {
  it("returns validated values without changing a valid database path", () => {
    expect(parseWorkerEnvironment(valid)).toEqual({
      dbPath: " /tmp/branchestra.sqlite3 ",
      ownerInstanceId: valid.BRANCHESTRA_OWNER_INSTANCE_ID,
      workerGeneration: valid.BRANCHESTRA_WORKER_GENERATION,
      startIdentity: valid.BRANCHESTRA_WORKER_START_IDENTITY
    });
  });

  it.each([
    ["BRANCHESTRA_DB_PATH", undefined],
    ["BRANCHESTRA_DB_PATH", "   "],
    ["BRANCHESTRA_OWNER_INSTANCE_ID", undefined],
    ["BRANCHESTRA_OWNER_INSTANCE_ID", "not-a-uuid"],
    ["BRANCHESTRA_WORKER_GENERATION", undefined],
    ["BRANCHESTRA_WORKER_GENERATION", "not-a-uuid"],
    ["BRANCHESTRA_WORKER_GENERATION", "00000000-0000-0000-0000-000000000000"],
    ["BRANCHESTRA_WORKER_START_IDENTITY", undefined],
    ["BRANCHESTRA_WORKER_START_IDENTITY", "not-a-uuid"]
  ])("rejects invalid %s before any worker startup", (name, value) => {
    const databaseCallSpy = vi.spyOn(DatabaseSync.prototype, "prepare");
    try {
      expect(() => parseWorkerEnvironment({ ...valid, [name]: value })).toThrow();
      expect(databaseCallSpy).not.toHaveBeenCalled();
    } finally {
      databaseCallSpy.mockRestore();
    }
  });
});
