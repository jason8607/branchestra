import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  WorkerEventEnvelopeSchema,
  WorkerRequestEnvelopeSchema,
  WorkerResponseEnvelopeSchema
} from "../../src/shared/contracts/protocol";
import { openDatabase } from "../../src/worker/storage/database";
import { createWorkerLeaseStore, type WorkerIdentity } from "../../src/worker/storage/worker-lease-store";
import { startWorker, type WorkerPort } from "../../src/worker/runtime";
import { runMigrations } from "../../src/worker/storage/migrations";
import { createRepositories } from "../../src/worker/storage/repositories";
import { createGitRepository } from "../fixtures/git-repository";

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

async function waitForResponses(port: FakePort, count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const responses = port.sent.filter(
      (value) => WorkerResponseEnvelopeSchema.safeParse(value).success
    );
    if (responses.length >= count) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  const responseCount = port.sent.filter(
    (value) => WorkerResponseEnvelopeSchema.safeParse(value).success
  ).length;
  throw new Error(`Timed out waiting for ${count} worker responses; observed ${responseCount}`);
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

  it("posts one room event after a new message response and not after its replay", async () => {
    const root = mkdtempSync(join(tmpdir(), "branchestra-worker-"));
    const dbPath = join(root, "branchestra.sqlite3");
    const generation = "50000000-0000-4000-8000-000000000070";
    const projectId = "20000000-0000-4000-8000-000000000070";
    const roomId = "30000000-0000-4000-8000-000000000070";
    const message = WorkerRequestEnvelopeSchema.parse({
      v: 1,
      requestId: "10000000-0000-4000-8000-000000000070",
      idempotencyKey: "message-post-70",
      workerGeneration: generation,
      type: "message.post",
      payload: { roomId, body: "Hello from the worker runtime" }
    });
    let runtime: Awaited<ReturnType<typeof startWorker>> | undefined;
    let seedDatabase: ReturnType<typeof openDatabase> | undefined;
    try {
      seedDatabase = openDatabase(dbPath);
      runMigrations(seedDatabase);
      const repositories = createRepositories(seedDatabase);
      repositories.projects.insert({
        id: projectId,
        repositoryRoot: "/seeded/project",
        gitCommonDir: "/seeded/project/.git",
        displayName: "seeded-project",
        headOid: "a".repeat(40),
        defaultBranch: "main",
        createdAt: "2026-07-22T00:00:00.000Z"
      });
      repositories.rooms.insert({
        id: roomId,
        projectId,
        title: "Seeded room",
        createdAt: "2026-07-22T00:00:00.000Z"
      });
      seedDatabase.close();
      seedDatabase = undefined;

      const port = fakePort();
      runtime = await startWorker(startOptions(dbPath, port, generation, 170));
      const sentBeforeMessage = port.sent.length;
      port.emit(message);
      await flushMessages();

      const firstPosts = port.sent.slice(sentBeforeMessage);
      expect(firstPosts).toHaveLength(2);
      const response = WorkerResponseEnvelopeSchema.parse(firstPosts[0]);
      expect(response).toMatchObject({
        v: 1,
        requestId: message.requestId,
        idempotencyKey: message.idempotencyKey,
        workerGeneration: generation,
        type: "response",
        payload: { ok: true, requestType: "message.post", replayed: false }
      });
      if (!response.payload.ok) throw new Error("Expected successful message.post response");
      const event = WorkerEventEnvelopeSchema.parse(firstPosts[1]);
      if (event.type !== "room.event") throw new Error("Expected room.event after response");
      expect(event).toMatchObject({
        v: 1,
        requestId: message.requestId,
        workerGeneration: generation,
        type: "room.event"
      });
      expect(event.idempotencyKey).toBe(event.payload.id);
      expect(event.payload).toEqual(response.payload.data);

      const replayRequestId = "10000000-0000-4000-8000-000000000071";
      const replayMessage = WorkerRequestEnvelopeSchema.parse({ ...message, requestId: replayRequestId });
      const sentBeforeReplay = port.sent.length;
      port.emit(replayMessage);
      await flushMessages();
      const replayPosts = port.sent.slice(sentBeforeReplay);
      expect(replayPosts).toHaveLength(1);
      const replay = WorkerResponseEnvelopeSchema.parse(replayPosts[0]);
      expect(replay).toMatchObject({
        requestId: replayRequestId,
        idempotencyKey: message.idempotencyKey,
        workerGeneration: generation,
        payload: { ok: true, requestType: "message.post", replayed: true }
      });
      expect(port.sent.flatMap((value) => {
        const parsed = WorkerEventEnvelopeSchema.safeParse(value);
        return parsed.success && parsed.data.type === "room.event" ? [parsed.data] : [];
      })).toHaveLength(1);
    } finally {
      seedDatabase?.close();
      await runtime?.prepareQuit(Date.now() + 1_000);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains the approval workflow when explicit manual conversation mode is requested", async () => {
    const root = mkdtempSync(join(tmpdir(), "branchestra-worker-task-"));
    const repository = createGitRepository();
    const dbPath = join(root, "branchestra.sqlite3");
    const generation = "50000000-0000-4000-8000-000000000080";
    const projectId = "20000000-0000-4000-8000-000000000080";
    const roomId = "30000000-0000-4000-8000-000000000080";
    const message = WorkerRequestEnvelopeSchema.parse({
      v: 1,
      requestId: "10000000-0000-4000-8000-000000000080",
      idempotencyKey: "message-post-80",
      workerGeneration: generation,
      type: "message.post",
      payload: {
        roomId,
        body: "@Claude implement parser",
        leadProvider: "claude",
        commandClasses: ["test", "lint"],
        allowCollaborator: true,
        toolNetwork: false,
        maxRunMs: 120_000,
        collaborationRoundBudget: 2
      }
    });
    let runtime: Awaited<ReturnType<typeof startWorker>> | undefined;
    let database: ReturnType<typeof openDatabase> | undefined;
    try {
      database = openDatabase(dbPath);
      runMigrations(database);
      const seeded = createRepositories(database);
      seeded.projects.insert({
        id: projectId,
        repositoryRoot: repository.root,
        gitCommonDir: repository.commonDirRealpath,
        displayName: "runtime-task-repository",
        headOid: repository.initialOid,
        defaultBranch: "main",
        createdAt: "2026-07-24T00:00:00.000Z"
      });
      seeded.rooms.insert({
        id: roomId,
        projectId,
        title: "Runtime task room",
        createdAt: "2026-07-24T00:00:00.000Z"
      });
      database.close();
      database = undefined;

      const port = fakePort();
      runtime = await startWorker({
        ...startOptions(dbPath, port, generation, 180),
        conversationMode: "manual"
      });
      port.emit(message);
      await waitForResponses(port, 1);
      const response = port.sent.flatMap((value) => {
        const parsed = WorkerResponseEnvelopeSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      }).at(-1);
      expect(response?.payload).toMatchObject({
        ok: true,
        requestType: "message.post",
        replayed: false
      });

      port.emit({ ...message, requestId: "10000000-0000-4000-8000-000000000081" });
      await waitForResponses(port, 2);
      await runtime.prepareQuit(Date.now() + 1_000);
      runtime = undefined;

      database = openDatabase(dbPath);
      const persisted = createRepositories(database);
      const tasks = persisted.tasks.listNonTerminal();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        roomId,
        leadProvider: "claude",
        state: "AwaitingApproval",
        baseOid: repository.initialOid
      });
      expect(persisted.approvals.getPendingRequest(tasks[0]!.id)).toMatchObject({
        kind: "task_scope",
        scope: {
          commandClasses: ["lint", "test"],
          toolNetwork: false,
          collaborationRoundBudget: 2
        }
      });
      expect(persisted.approvals.listForTask(tasks[0]!.id)).toEqual([]);
      expect(database.prepare(
        "SELECT event_type, count(*) AS count FROM room_events WHERE event_type IN ('task.created','approval.requested') GROUP BY event_type ORDER BY event_type"
      ).all()).toEqual([
        { event_type: "approval.requested", count: 1 },
        { event_type: "task.created", count: 1 }
      ]);
    } finally {
      database?.close();
      await runtime?.prepareQuit(Date.now() + 1_000);
      repository.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
