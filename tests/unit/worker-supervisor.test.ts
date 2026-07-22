import { describe, expect, it, vi } from "vitest";
import { createWorkerSupervisor, type UtilityProcessAdapter, type UtilityProcessChild } from "../../src/main/worker/supervisor";

const ownerInstanceId = "60000000-0000-4000-8000-000000000001";
const generation = "50000000-0000-4000-8000-000000000001";

class FakeChild implements UtilityProcessChild {
  readonly messages: unknown[] = [];
  killCalls = 0;
  private readonly messageListeners = new Set<(value: unknown) => void>();
  private readonly exitListeners = new Set<(code: number) => void>();

  postMessage(value: unknown): void { this.messages.push(value); }
  onMessage(listener: (value: unknown) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }
  onExit(listener: (code: number) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
  kill(): boolean { this.killCalls += 1; return true; }
  emitMessage(value: unknown): void { for (const listener of this.messageListeners) listener(value); }
  emitExit(code = 1): void { for (const listener of this.exitListeners) listener(code); }
}

class FakeAdapter implements UtilityProcessAdapter {
  readonly children: FakeChild[] = [];
  readonly forks: Array<{ modulePath: string; env: Record<string, string> }> = [];
  fork(modulePath: string, options: { env: Record<string, string> }): FakeChild {
    const child = new FakeChild();
    this.children.push(child);
    this.forks.push({ modulePath, env: options.env });
    return child;
  }
}

interface ScheduledTask {
  delayMs: number;
  callback: () => void;
  cancelled: boolean;
}

class FakeScheduler {
  readonly tasks: ScheduledTask[] = [];
  readonly schedule = (delayMs: number, callback: () => void): (() => void) => {
    const task = { delayMs, callback, cancelled: false };
    this.tasks.push(task);
    return () => { task.cancelled = true; };
  };
  runNext(delayMs: number): void {
    const task = this.tasks.find((candidate) => !candidate.cancelled && candidate.delayMs === delayMs);
    if (!task) throw new Error(`No active ${delayMs}ms task`);
    task.cancelled = true;
    task.callback();
  }
  activeDelays(): number[] {
    return this.tasks.filter((task) => !task.cancelled).map((task) => task.delayMs);
  }
}

function readyEnvelope(workerGeneration: string) {
  return {
    v: 1,
    requestId: "10000000-0000-4000-8000-000000000001",
    idempotencyKey: "worker-handshake",
    workerGeneration,
    type: "worker.ready",
    payload: { protocolVersion: 1 }
  };
}

function prepareQuitRequest(workerGeneration: string, requestId = "20000000-0000-4000-8000-000000000001") {
  return {
    v: 1 as const,
    requestId,
    idempotencyKey: `quit:${requestId}`,
    workerGeneration,
    type: "worker.prepareQuit" as const,
    payload: { deadlineMs: 9_999_999_999_999 }
  };
}

function preparedResponse(workerGeneration: string, requestId = "20000000-0000-4000-8000-000000000001") {
  return {
    v: 1,
    requestId,
    idempotencyKey: `quit:${requestId}`,
    workerGeneration,
    type: "response",
    payload: {
      ok: true,
      requestType: "worker.prepareQuit",
      data: { prepared: true },
      replayed: false
    }
  };
}

function rejectedEnvelope(workerGeneration: string): unknown {
  return {
    v: 1,
    requestId: "40000000-0000-4000-8000-000000000001",
    idempotencyKey: "worker-handshake-rejected",
    workerGeneration,
    type: "worker.rejected",
    payload: { code: "LEASE_HELD" }
  };
}

describe("worker supervisor", () => {
  it("resolves start only for a schema-valid ready envelope from its generation", async () => {
    const adapter = new FakeAdapter();
    const supervisor = createWorkerSupervisor({
      utilityProcess: adapter,
      workerEntry: "/app/out/main/worker.js",
      dbPath: "/data/branchestra.sqlite3",
      ownerInstanceId,
      nextGeneration: () => generation,
      restartBackoffMs: [100, 250, 500, 1000, 2000],
      schedule: () => () => undefined
    });

    const starting = supervisor.start();
    expect(adapter.children).toHaveLength(1);
    adapter.children[0]!.emitMessage(readyEnvelope(generation));

    await expect(starting).resolves.toEqual({ workerGeneration: generation });
  });

  it("spawns with only the portable allowlist and worker identity variables", () => {
    const adapter = new FakeAdapter();
    const supervisor = createWorkerSupervisor({
      utilityProcess: adapter,
      workerEntry: "/app/out/main/worker.js",
      dbPath: "/data/branchestra.sqlite3",
      ownerInstanceId,
      nextGeneration: () => generation,
      restartBackoffMs: [100, 250, 500, 1000, 2000],
      schedule: () => () => undefined,
      environment: {
        LANG: "en_US.UTF-8",
        LC_ALL: "C.UTF-8",
        TMPDIR: "/private/tmp",
        HOME: "/secret/home",
        API_TOKEN: "do-not-copy"
      }
    });

    void supervisor.start();

    expect(adapter.forks[0]?.modulePath).toBe("/app/out/main/worker.js");
    expect(adapter.forks[0]?.env).toEqual({
      LANG: "en_US.UTF-8",
      LC_ALL: "C.UTF-8",
      TMPDIR: "/private/tmp",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      BRANCHESTRA_DB_PATH: "/data/branchestra.sqlite3",
      BRANCHESTRA_OWNER_INSTANCE_ID: ownerInstanceId,
      BRANCHESTRA_WORKER_GENERATION: generation,
      BRANCHESTRA_WORKER_START_IDENTITY: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      )
    });
  });

  it("replaces a child that does not send a matching valid ready envelope within five seconds", async () => {
    const adapter = new FakeAdapter();
    const scheduler = new FakeScheduler();
    const generations = [
      "50000000-0000-4000-8000-000000000001",
      "50000000-0000-4000-8000-000000000002"
    ];
    const supervisor = createWorkerSupervisor({
      utilityProcess: adapter,
      workerEntry: "/app/out/main/worker.js",
      dbPath: "/data/branchestra.sqlite3",
      ownerInstanceId,
      nextGeneration: () => generations.shift()!,
      restartBackoffMs: [100, 250, 500, 1000, 2000],
      schedule: scheduler.schedule
    });

    const starting = supervisor.start();
    adapter.children[0]!.emitMessage(readyEnvelope("50000000-0000-4000-8000-000000000099"));
    adapter.children[0]!.emitMessage({ ...readyEnvelope(generation), v: 2 });
    expect(scheduler.activeDelays()).toEqual([5_000]);

    scheduler.runNext(5_000);
    expect(adapter.children[0]!.killCalls).toBe(1);
    expect(scheduler.activeDelays()).toEqual([100]);
    scheduler.runNext(100);
    expect(adapter.children).toHaveLength(2);
    adapter.children[1]!.emitMessage(readyEnvelope("50000000-0000-4000-8000-000000000002"));

    await expect(starting).resolves.toEqual({
      workerGeneration: "50000000-0000-4000-8000-000000000002"
    });
  });

  it("correlates schema-valid responses and forwards only schema-valid current-generation events", async () => {
    const adapter = new FakeAdapter();
    const supervisor = createWorkerSupervisor({
      utilityProcess: adapter,
      workerEntry: "/app/out/main/worker.js",
      dbPath: "/data/branchestra.sqlite3",
      ownerInstanceId,
      nextGeneration: () => generation,
      restartBackoffMs: [100, 250, 500, 1000, 2000],
      schedule: () => () => undefined
    });
    const starting = supervisor.start();
    adapter.children[0]!.emitMessage(readyEnvelope(generation));
    await starting;
    const listener = vi.fn();
    supervisor.subscribe(listener);
    const request = prepareQuitRequest(generation);

    const response = supervisor.request(request);
    expect(adapter.children[0]!.messages).toEqual([request]);
    adapter.children[0]!.emitMessage(preparedResponse(generation, "20000000-0000-4000-8000-000000000099"));
    adapter.children[0]!.emitMessage({ ...preparedResponse(generation), extra: true });
    adapter.children[0]!.emitMessage(preparedResponse(generation));
    await expect(response).resolves.toMatchObject({ requestId: request.requestId });

    const validEvent = {
      v: 1,
      requestId: "30000000-0000-4000-8000-000000000001",
      idempotencyKey: "invalidate:1",
      workerGeneration: generation,
      type: "state.invalidated",
      payload: { roomId: null }
    };
    adapter.children[0]!.emitMessage({ ...validEvent, extra: true });
    adapter.children[0]!.emitMessage({
      ...validEvent,
      workerGeneration: "50000000-0000-4000-8000-000000000099"
    });
    adapter.children[0]!.emitMessage(validEvent);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(validEvent);
    expect(supervisor.getGeneration()).toBe(generation);
  });

  it("rejects pending requests, emits disconnected, and uses the exact capped restart sequence on exits", async () => {
    const adapter = new FakeAdapter();
    const scheduler = new FakeScheduler();
    const generations = Array.from(
      { length: 7 },
      (_, index) => `50000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
    );
    let generationIndex = 0;
    const supervisor = createWorkerSupervisor({
      utilityProcess: adapter,
      workerEntry: "/app/out/main/worker.js",
      dbPath: "/data/branchestra.sqlite3",
      ownerInstanceId,
      nextGeneration: () => generations[generationIndex++]!,
      restartBackoffMs: [100, 250, 500, 1000, 2000],
      schedule: scheduler.schedule
    });
    const listener = vi.fn();
    supervisor.subscribe(listener);
    const starting = supervisor.start();
    adapter.children[0]!.emitMessage(readyEnvelope(generations[0]!));
    await starting;
    listener.mockClear();
    const pending = supervisor.request(prepareQuitRequest(generations[0]!));

    adapter.children[0]!.emitExit(17);

    await expect(pending).rejects.toThrow(/disconnected/i);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      v: 1,
      workerGeneration: generations[0],
      type: "worker.disconnected",
      payload: { reason: "exit:17" }
    });
    expect(() => {
      const event = listener.mock.calls[0]?.[0] as { requestId?: string; idempotencyKey?: string };
      expect(event.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(event.idempotencyKey).toBe(`worker-disconnected:${generations[0]}`);
    }).not.toThrow();

    const expectedDelays = [100, 250, 500, 1000, 2000, 2000];
    for (const delayMs of expectedDelays) {
      scheduler.runNext(delayMs);
      adapter.children.at(-1)!.emitExit(17);
    }
    expect(
      scheduler.tasks
        .map((task) => task.delayMs)
        .filter((delayMs) => delayMs !== 5_000)
    ).toEqual([...expectedDelays, 2000]);
  });

  it("restarts after LEASE_HELD and resets backoff only after five ready seconds", async () => {
    const adapter = new FakeAdapter();
    const scheduler = new FakeScheduler();
    const generations = [
      "50000000-0000-4000-8000-000000000001",
      "50000000-0000-4000-8000-000000000002",
      "50000000-0000-4000-8000-000000000003"
    ];
    let generationIndex = 0;
    const supervisor = createWorkerSupervisor({
      utilityProcess: adapter,
      workerEntry: "/app/out/main/worker.js",
      dbPath: "/data/branchestra.sqlite3",
      ownerInstanceId,
      nextGeneration: () => generations[generationIndex++]!,
      restartBackoffMs: [100, 250, 500, 1000, 2000],
      schedule: scheduler.schedule
    });
    const listener = vi.fn();
    supervisor.subscribe(listener);
    const starting = supervisor.start();

    adapter.children[0]!.emitMessage(rejectedEnvelope(generations[0]!));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: "worker.rejected" }));
    expect(adapter.children[0]!.killCalls).toBe(1);
    scheduler.runNext(100);
    adapter.children[1]!.emitMessage(readyEnvelope(generations[1]!));
    await expect(starting).resolves.toEqual({ workerGeneration: generations[1] });

    adapter.children[1]!.emitExit();
    expect(scheduler.activeDelays()).toContain(250);
    scheduler.runNext(250);
    adapter.children[2]!.emitMessage(readyEnvelope(generations[2]!));
    expect(scheduler.activeDelays()).toContain(5_000);
    scheduler.runNext(5_000);
    adapter.children[2]!.emitExit();

    expect(scheduler.activeDelays()).toContain(100);
  });

  it("performs one idempotent prepare-quit handshake and does not kill after prepared success", async () => {
    const adapter = new FakeAdapter();
    const scheduler = new FakeScheduler();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const supervisor = createWorkerSupervisor({
      utilityProcess: adapter,
      workerEntry: "/app/out/main/worker.js",
      dbPath: "/data/branchestra.sqlite3",
      ownerInstanceId,
      nextGeneration: () => generation,
      restartBackoffMs: [100, 250, 500, 1000, 2000],
      schedule: scheduler.schedule
    });
    const starting = supervisor.start();
    adapter.children[0]!.emitMessage(readyEnvelope(generation));
    await starting;

    const first = supervisor.stop(6_000);
    const second = supervisor.stop(6_000);
    expect(first).toBe(second);
    expect(adapter.children[0]!.messages).toHaveLength(1);
    const quitRequest = adapter.children[0]!.messages[0] as ReturnType<typeof prepareQuitRequest>;
    expect(quitRequest).toMatchObject({
      v: 1,
      workerGeneration: generation,
      type: "worker.prepareQuit",
      payload: { deadlineMs: 6_000 }
    });
    adapter.children[0]!.emitMessage(preparedResponse(generation, quitRequest.requestId));

    await expect(first).resolves.toBeUndefined();
    expect(adapter.children[0]!.killCalls).toBe(0);
    expect(supervisor.getGeneration()).toBeNull();
    now.mockRestore();
  });

  it("kills at the absolute deadline and never restarts once stopping", async () => {
    const adapter = new FakeAdapter();
    const scheduler = new FakeScheduler();
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const supervisor = createWorkerSupervisor({
      utilityProcess: adapter,
      workerEntry: "/app/out/main/worker.js",
      dbPath: "/data/branchestra.sqlite3",
      ownerInstanceId,
      nextGeneration: () => generation,
      restartBackoffMs: [100, 250, 500, 1000, 2000],
      schedule: scheduler.schedule
    });
    const starting = supervisor.start();
    adapter.children[0]!.emitMessage(readyEnvelope(generation));
    await starting;

    const stopping = supervisor.stop(10_750);
    expect(adapter.children[0]!.messages).toHaveLength(1);
    adapter.children[0]!.emitExit(1);
    expect(scheduler.activeDelays()).toEqual([750]);
    scheduler.runNext(750);

    await stopping;
    expect(adapter.children[0]!.killCalls).toBe(1);
    expect(adapter.children).toHaveLength(1);
    now.mockRestore();
  });
});
