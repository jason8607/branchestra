import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../src/worker/storage/database";
import { createWorkerLeaseStore, type WorkerIdentity } from "../../src/worker/storage/worker-lease-store";
import { startWorker, type WorkerPort } from "../../src/worker/runtime";

interface FakePort extends WorkerPort {
  sent: unknown[];
  emit(value: unknown): void;
}

function fakePort(options: {
  onMessage?: (listener: (value: unknown) => void) => (() => void);
  postMessage?: (value: unknown) => void;
} = {}): FakePort {
  const listeners = new Set<(value: unknown) => void>();
  return {
    sent: [],
    postMessage(value) {
      this.sent.push(value);
      options.postMessage?.(value);
    },
    onMessage(listener) {
      return options.onMessage?.(listener) ?? (() => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      })();
    },
    emit(value) {
      for (const listener of listeners) listener(value);
    }
  };
}

function identity(generation: string, pid = 101): WorkerIdentity {
  return {
    ownerInstanceId: `60000000-0000-4000-8000-0000000000${pid.toString().padStart(2, "0")}`,
    workerGeneration: generation,
    pid,
    startIdentity: `${pid}:1`
  };
}

function startOptions(dbPath: string, port: WorkerPort, generation: string, pid = 101) {
  return {
    dbPath,
    port,
    identity: identity(generation, pid),
    leaseTtlMs: 5_000,
    heartbeatIntervalMs: 1_000
  };
}

function prepareQuitRequest(generation: string) {
  return {
    v: 1,
    requestId: "10000000-0000-4000-8000-000000000001",
    idempotencyKey: "prepare-quit",
    workerGeneration: generation,
    type: "worker.prepareQuit",
    payload: { deadlineMs: Date.now() + 1_000 }
  };
}

async function flushMessages(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("worker runtime lease", () => {
  it("announces only one ready owner for a database", async () => {
    const root = mkdtempSync(join(tmpdir(), "branchestra-worker-"));
    const dbPath = join(root, "branchestra.sqlite3");
    let first: Awaited<ReturnType<typeof startWorker>> | undefined;
    let second: Awaited<ReturnType<typeof startWorker>> | undefined;
    let third: Awaited<ReturnType<typeof startWorker>> | undefined;

    try {
      const firstPort = fakePort();
      const secondPort = fakePort();
      first = await startWorker(startOptions(dbPath, firstPort, "50000000-0000-4000-8000-000000000001"));
      second = await startWorker(startOptions(dbPath, secondPort, "50000000-0000-4000-8000-000000000002", 102));
      expect(firstPort.sent).toContainEqual(expect.objectContaining({ type: "worker.ready", workerGeneration: "50000000-0000-4000-8000-000000000001" }));
      expect(secondPort.sent).toContainEqual(expect.objectContaining({ type: "worker.rejected", payload: { code: "LEASE_HELD" } }));
      await first.prepareQuit(Date.now() + 1_000);
      await second.prepareQuit(Date.now() + 1_000);
      const thirdPort = fakePort();
      third = await startWorker(startOptions(dbPath, thirdPort, "50000000-0000-4000-8000-000000000003", 103));
      expect(thirdPort.sent).toContainEqual(expect.objectContaining({ type: "worker.ready", workerGeneration: "50000000-0000-4000-8000-000000000003" }));
    } finally {
      await third?.prepareQuit(Date.now() + 1_000);
      await second?.prepareQuit(Date.now() + 1_000);
      await first?.prepareQuit(Date.now() + 1_000);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("releases an acquired lease when ready posting or listener registration fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "branchestra-worker-"));
    const dbPath = join(root, "branchestra.sqlite3");
    let replacement: Awaited<ReturnType<typeof startWorker>> | undefined;
    try {
      const readyFailure = fakePort({
        postMessage(value) {
          if ((value as { type?: string }).type === "worker.ready") throw new Error("ready post failed");
        }
      });
      await expect(startWorker(startOptions(dbPath, readyFailure, "50000000-0000-4000-8000-000000000010", 110))).rejects.toThrow("ready post failed");
      const replacementPort = fakePort();
      replacement = await startWorker(startOptions(dbPath, replacementPort, "50000000-0000-4000-8000-000000000011", 111));
      expect(replacementPort.sent).toContainEqual(expect.objectContaining({ type: "worker.ready" }));
      await replacement.prepareQuit(Date.now() + 1_000);
      replacement = undefined;

      const registrationFailure = fakePort({ onMessage: () => { throw new Error("listener registration failed"); } });
      await expect(startWorker(startOptions(dbPath, registrationFailure, "50000000-0000-4000-8000-000000000012", 112))).rejects.toThrow("listener registration failed");
      const secondReplacementPort = fakePort();
      replacement = await startWorker(startOptions(dbPath, secondReplacementPort, "50000000-0000-4000-8000-000000000013", 113));
      expect(secondReplacementPort.sent).toContainEqual(expect.objectContaining({ type: "worker.ready" }));
    } finally {
      await replacement?.prepareQuit(Date.now() + 1_000);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("releases an acquired lease when heartbeat setup fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "branchestra-worker-"));
    const dbPath = join(root, "branchestra.sqlite3");
    const timerSpy = vi.spyOn(globalThis, "setInterval").mockImplementationOnce(() => {
      throw new Error("heartbeat setup failed");
    });
    let replacement: Awaited<ReturnType<typeof startWorker>> | undefined;
    try {
      await expect(startWorker(startOptions(dbPath, fakePort(), "50000000-0000-4000-8000-000000000014", 114))).rejects.toThrow("heartbeat setup failed");
      timerSpy.mockRestore();
      const replacementPort = fakePort();
      replacement = await startWorker(startOptions(dbPath, replacementPort, "50000000-0000-4000-8000-000000000015", 115));
      expect(replacementPort.sent).toContainEqual(expect.objectContaining({ type: "worker.ready" }));
    } finally {
      timerSpy.mockRestore();
      await replacement?.prepareQuit(Date.now() + 1_000);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not resurrect heartbeat or ready after synchronous prepareQuit during listener registration", async () => {
    const root = mkdtempSync(join(tmpdir(), "branchestra-worker-"));
    const dbPath = join(root, "branchestra.sqlite3");
    const generation = "50000000-0000-4000-8000-000000000020";
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const unsubscribe = vi.fn();
    let runtime: Awaited<ReturnType<typeof startWorker>> | undefined;
    try {
      const port = fakePort({
        onMessage(listener) {
          listener(prepareQuitRequest(generation));
          return unsubscribe;
        }
      });
      runtime = await startWorker(startOptions(dbPath, port, generation, 120));
      await flushMessages();
      expect(port.sent).not.toContainEqual(expect.objectContaining({ type: "worker.ready" }));
      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(unsubscribe).toHaveBeenCalledOnce();
    } finally {
      setIntervalSpy.mockRestore();
      await runtime?.prepareQuit(Date.now() + 1_000);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns correlated INVALID_REQUEST responses and controlled-stops uncorrelated malformed input", async () => {
    const root = mkdtempSync(join(tmpdir(), "branchestra-worker-"));
    const dbPath = join(root, "branchestra.sqlite3");
    const generation = "50000000-0000-4000-8000-000000000030";
    let runtime: Awaited<ReturnType<typeof startWorker>> | undefined;
    let replacement: Awaited<ReturnType<typeof startWorker>> | undefined;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const port = fakePort();
      runtime = await startWorker(startOptions(dbPath, port, generation, 130));
      port.emit({ ...prepareQuitRequest(generation), type: "room.create", payload: {} });
      await flushMessages();
      expect(port.sent).toContainEqual(expect.objectContaining({
        type: "response",
        payload: expect.objectContaining({ ok: false, requestType: "room.create", code: "INVALID_REQUEST" })
      }));
      port.emit({
        ...prepareQuitRequest("50000000-0000-4000-8000-000000000099"),
        requestId: "10000000-0000-4000-8000-000000000003",
        idempotencyKey: "stale-malformed-request",
        type: "room.create",
        payload: {}
      });
      await flushMessages();
      expect(port.sent).toContainEqual(expect.objectContaining({
        requestId: "10000000-0000-4000-8000-000000000003",
        workerGeneration: generation,
        payload: expect.objectContaining({ ok: false, code: "INVALID_REQUEST" })
      }));
      port.emit({
        ...prepareQuitRequest(generation),
        requestId: "10000000-0000-4000-8000-000000000002",
        idempotencyKey: "oversized-request",
        type: "room.create",
        payload: { projectId: "20000000-0000-4000-8000-000000000001", title: "x".repeat(65_536) }
      });
      await flushMessages();
      expect(port.sent).toContainEqual(expect.objectContaining({
        requestId: "10000000-0000-4000-8000-000000000002",
        payload: expect.objectContaining({ ok: false, code: "INVALID_REQUEST" })
      }));
      port.emit({ unexpected: true });
      await flushMessages();
      replacement = await startWorker(startOptions(dbPath, fakePort(), "50000000-0000-4000-8000-000000000031", 131));
      expect(replacement).toBeDefined();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await replacement?.prepareQuit(Date.now() + 1_000);
      await runtime?.prepareQuit(Date.now() + 1_000);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops a stale owner after heartbeat failure without deleting its replacement lease", async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "branchestra-worker-"));
    const dbPath = join(root, "branchestra.sqlite3");
    let first: Awaited<ReturnType<typeof startWorker>> | undefined;
    let externalDatabase: ReturnType<typeof openDatabase> | undefined;
    try {
      const firstIdentity = identity("50000000-0000-4000-8000-000000000040", 140);
      first = await startWorker({ ...startOptions(dbPath, fakePort(), firstIdentity.workerGeneration, firstIdentity.pid), identity: firstIdentity });
      externalDatabase = openDatabase(dbPath);
      const externalLease = createWorkerLeaseStore(externalDatabase);
      const replacementIdentity = identity("50000000-0000-4000-8000-000000000041", 141);
      expect(externalLease.acquire(replacementIdentity, Date.now() + 10_000, 5_000)).toBe("acquired");
      await vi.advanceTimersByTimeAsync(1_000);
      await first.prepareQuit(Date.now() + 1_000);
      expect(externalLease.heartbeat(replacementIdentity, Date.now())).toBe(true);
    } finally {
      externalDatabase?.close();
      await first?.prepareQuit(Date.now() + 1_000);
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("contains heartbeat and shutdown cleanup failures", async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "branchestra-worker-"));
    const dbPath = join(root, "branchestra.sqlite3");
    let heartbeatRuntime: Awaited<ReturnType<typeof startWorker>> | undefined;
    let releaseRuntime: Awaited<ReturnType<typeof startWorker>> | undefined;
    let closeRuntime: Awaited<ReturnType<typeof startWorker>> | undefined;
    try {
      heartbeatRuntime = await startWorker(startOptions(dbPath, fakePort(), "50000000-0000-4000-8000-000000000050", 150));
      const prepareSpy = vi.spyOn(DatabaseSync.prototype, "prepare");
      prepareSpy.mockImplementationOnce(() => { throw new Error("heartbeat failed"); });
      await vi.advanceTimersByTimeAsync(1_000);
      prepareSpy.mockRestore();
      await expect(heartbeatRuntime.prepareQuit(Date.now() + 1_000)).resolves.toBeUndefined();

      releaseRuntime = await startWorker(startOptions(dbPath, fakePort(), "50000000-0000-4000-8000-000000000051", 151));
      const originalPrepare = DatabaseSync.prototype.prepare;
      const releaseSpy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
        if (sql.startsWith("DELETE FROM worker_leases")) throw new Error("release failed");
        return originalPrepare.call(this, sql);
      });
      await expect(releaseRuntime.prepareQuit(Date.now() + 1_000)).resolves.toBeUndefined();
      releaseSpy.mockRestore();

      const releaseCleanupDatabase = openDatabase(dbPath);
      createWorkerLeaseStore(releaseCleanupDatabase).release(identity("50000000-0000-4000-8000-000000000051", 151));
      releaseCleanupDatabase.close();

      closeRuntime = await startWorker(startOptions(dbPath, fakePort(), "50000000-0000-4000-8000-000000000052", 152));
      const originalClose = DatabaseSync.prototype.close;
      const closeSpy = vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function (this: DatabaseSync) {
        originalClose.call(this);
        throw new Error("close failed");
      });
      await expect(closeRuntime.prepareQuit(Date.now() + 1_000)).resolves.toBeUndefined();
      closeSpy.mockRestore();
    } finally {
      await closeRuntime?.prepareQuit(Date.now() + 1_000);
      await releaseRuntime?.prepareQuit(Date.now() + 1_000);
      await heartbeatRuntime?.prepareQuit(Date.now() + 1_000);
      vi.restoreAllMocks();
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("closes the raw database when migrations or lease acquisition fail", async () => {
    const root = mkdtempSync(join(tmpdir(), "branchestra-worker-"));
    const dbPath = join(root, "branchestra.sqlite3");
    const originalExec = DatabaseSync.prototype.exec;
    const originalPrepare = DatabaseSync.prototype.prepare;
    const closeSpy = vi.spyOn(DatabaseSync.prototype, "close");
    try {
      const migrationSpy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
        if (sql.startsWith("CREATE TABLE IF NOT EXISTS schema_migrations")) throw new Error("migration failed");
        return originalExec.call(this, sql);
      });
      await expect(startWorker(startOptions(dbPath, fakePort(), "50000000-0000-4000-8000-000000000060", 160))).rejects.toThrow("migration failed");
      expect(closeSpy).toHaveBeenCalledTimes(1);
      migrationSpy.mockRestore();
      closeSpy.mockClear();

      const acquisitionSpy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
        if (sql.startsWith("SELECT owner_instance_id")) throw new Error("acquisition failed");
        return originalPrepare.call(this, sql);
      });
      await expect(startWorker(startOptions(dbPath, fakePort(), "50000000-0000-4000-8000-000000000061", 161))).rejects.toThrow("acquisition failed");
      expect(closeSpy).toHaveBeenCalledTimes(1);
      acquisitionSpy.mockRestore();
    } finally {
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
