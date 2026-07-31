import { describe, expect, it, vi } from "vitest";
import { contextBridge, ipcRenderer } from "electron";
import { createPreloadApi, type PreloadTransport } from "../../src/preload/api";
import {
  ZERO_WORKER_GENERATION,
  type RendererRequestEnvelope,
  type WorkerEventEnvelope
} from "../../src/shared/contracts/protocol";

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn()
  }
}));

const generation = "50000000-0000-4000-8000-000000000001";
const nextGeneration = "50000000-0000-4000-8000-000000000002";

function snapshotResponse(request: RendererRequestEnvelope, workerGeneration = generation) {
  return {
    v: 1 as const,
    requestId: request.requestId,
    idempotencyKey: request.idempotencyKey,
    workerGeneration,
    type: "response" as const,
    payload: {
      ok: true as const,
      requestType: "state.getSnapshot",
      data: { projects: [], rooms: [], tasks: [], roomCursors: {} },
      replayed: false
    }
  };
}

function validEvent(workerGeneration = nextGeneration): WorkerEventEnvelope {
  return {
    v: 1,
    requestId: "30000000-0000-4000-8000-000000000001",
    idempotencyKey: "invalidate-1",
    workerGeneration,
    type: "state.invalidated",
    payload: { roomId: null }
  };
}

function fakePreloadTransport() {
  const invocations: Array<{ channel: string; value: RendererRequestEnvelope }> = [];
  const pending: Array<{ resolve(value: unknown): void; reject(error: unknown): void }> = [];
  const listeners = new Set<(value: unknown) => void>();
  const unsubscribe = vi.fn((listener: (value: unknown) => void) => listeners.delete(listener));
  const transport: PreloadTransport = {
    invoke(channel, value) {
      invocations.push({ channel, value: value as RendererRequestEnvelope });
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    on(channel, listener) {
      expect(channel).toBe("branchestra:event");
      listeners.add(listener);
      return () => { unsubscribe(listener); };
    }
  };
  return {
    transport,
    invocations,
    unsubscribe,
    resolveNext(value: unknown): void {
      const correlation = pending.shift();
      if (!correlation) throw new Error("No pending preload invocation");
      correlation.resolve(value);
    },
    emit(value: unknown): void {
      for (const listener of listeners) listener(value);
    }
  };
}

describe("preload API", () => {
  it("uses the injected sandbox UUID source for request correlation", () => {
    const fixture = fakePreloadTransport();
    const requestId = "10000000-0000-4000-8000-000000000099";
    const api = createPreloadApi(fixture.transport, () => requestId);

    void api.request({
      type: "state.getSnapshot",
      payload: {},
      idempotencyKey: "snapshot-1"
    });

    expect(fixture.invocations[0]!.value.requestId).toBe(requestId);
  });

  it("exposes only frozen request and subscribe methods and learns generation from responses", async () => {
    const fixture = fakePreloadTransport();
    const api = createPreloadApi(fixture.transport);

    expect(Object.keys(api).sort()).toEqual(["request", "subscribe"]);
    expect(Object.isFrozen(api)).toBe(true);
    const bootstrap = api.request({
      type: "state.getSnapshot",
      payload: {},
      idempotencyKey: "snapshot-1"
    });
    expect(fixture.invocations[0]).toMatchObject({
      channel: "branchestra:request",
      value: {
        workerGeneration: ZERO_WORKER_GENERATION,
        type: "state.getSnapshot",
        payload: {}
      }
    });
    fixture.resolveNext(snapshotResponse(fixture.invocations[0]!.value));
    await bootstrap;

    void api.request({
      type: "project.pickExisting",
      payload: {},
      idempotencyKey: "pick-1"
    });
    expect(fixture.invocations[1]).toMatchObject({
      channel: "branchestra:request",
      value: {
        workerGeneration: generation,
        type: "project.pickExisting",
        payload: {}
      }
    });
  });

  it("does not learn generation from a schema-invalid response", async () => {
    const fixture = fakePreloadTransport();
    const api = createPreloadApi(fixture.transport);
    const bootstrap = api.request({
      type: "state.getSnapshot",
      payload: {},
      idempotencyKey: "snapshot-1"
    });
    fixture.resolveNext(snapshotResponse(fixture.invocations[0]!.value));
    await bootstrap;

    const invalid = api.request({
      type: "state.getSnapshot",
      payload: {},
      idempotencyKey: "snapshot-2"
    });
    fixture.resolveNext({
      ...snapshotResponse(fixture.invocations[1]!.value, nextGeneration),
      extra: true
    });
    await expect(invalid).rejects.toThrow();
    void api.request({
      type: "project.pickExisting",
      payload: {},
      idempotencyKey: "pick-1"
    });

    expect(fixture.invocations[2]!.value.workerGeneration).toBe(generation);
  });

  it.each([
    ["requestId", (request: RendererRequestEnvelope) => ({
      ...snapshotResponse(request),
      requestId: "10000000-0000-4000-8000-000000000099"
    })],
    ["idempotencyKey", (request: RendererRequestEnvelope) => ({
      ...snapshotResponse(request),
      idempotencyKey: "wrong-key"
    })],
    ["requestType", (request: RendererRequestEnvelope) => ({
      ...snapshotResponse(request),
      payload: { ...snapshotResponse(request).payload, requestType: "room.create" }
    })]
  ] as const)("rejects an uncorrelated response with mismatched %s without learning generation", async (
    _field,
    responseFor
  ) => {
    const fixture = fakePreloadTransport();
    const api = createPreloadApi(fixture.transport);
    const request = api.request({
      type: "state.getSnapshot",
      payload: {},
      idempotencyKey: "snapshot-1"
    });
    fixture.resolveNext(responseFor(fixture.invocations[0]!.value));

    await expect(request).rejects.toThrow("Renderer response correlation mismatch");
    void api.request({
      type: "state.getSnapshot",
      payload: {},
      idempotencyKey: "snapshot-2"
    });
    expect(fixture.invocations[1]!.value.workerGeneration).toBe(ZERO_WORKER_GENERATION);
  });

  it("rejects a response generation that differs from its active request without learning it", async () => {
    const fixture = fakePreloadTransport();
    const api = createPreloadApi(fixture.transport);
    const bootstrap = api.request({
      type: "state.getSnapshot",
      payload: {},
      idempotencyKey: "snapshot-1"
    });
    fixture.resolveNext(snapshotResponse(fixture.invocations[0]!.value));
    await bootstrap;

    const stale = api.request({
      type: "state.getSnapshot",
      payload: {},
      idempotencyKey: "snapshot-2"
    });
    fixture.resolveNext(snapshotResponse(fixture.invocations[1]!.value, nextGeneration));
    await expect(stale).rejects.toThrow("Renderer response generation mismatch");
    void api.request({
      type: "project.pickExisting",
      payload: {},
      idempotencyKey: "pick-1"
    });
    expect(fixture.invocations[2]!.value.workerGeneration).toBe(generation);
  });

  it("does not let an obsolete in-flight response regress a newer event generation", async () => {
    const fixture = fakePreloadTransport();
    const api = createPreloadApi(fixture.transport);
    api.subscribe(() => undefined);
    const bootstrap = api.request({
      type: "state.getSnapshot",
      payload: {},
      idempotencyKey: "snapshot-1"
    });
    fixture.resolveNext(snapshotResponse(fixture.invocations[0]!.value));
    await bootstrap;

    const obsolete = api.request({
      type: "state.getSnapshot",
      payload: {},
      idempotencyKey: "snapshot-2"
    });
    fixture.emit(validEvent(nextGeneration));
    fixture.resolveNext(snapshotResponse(fixture.invocations[1]!.value, generation));
    await expect(obsolete).rejects.toThrow("Renderer response generation is obsolete");
    void api.request({
      type: "project.pickExisting",
      payload: {},
      idempotencyKey: "pick-1"
    });
    expect(fixture.invocations[2]!.value.workerGeneration).toBe(nextGeneration);
  });

  it("validates subscribed events before learning generation or notifying listeners", async () => {
    const fixture = fakePreloadTransport();
    const api = createPreloadApi(fixture.transport);
    const listener = vi.fn();
    api.subscribe(listener);

    expect(() => fixture.emit({ ...validEvent(), extra: true })).toThrow();
    expect(listener).not.toHaveBeenCalled();
    void api.request({
      type: "state.getSnapshot",
      payload: {},
      idempotencyKey: "snapshot-1"
    });
    expect(fixture.invocations[0]!.value.workerGeneration).toBe(ZERO_WORKER_GENERATION);

    fixture.emit(validEvent());
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(validEvent());
    void api.request({
      type: "project.pickExisting",
      payload: {},
      idempotencyKey: "pick-1"
    });
    expect(fixture.invocations[1]!.value.workerGeneration).toBe(nextGeneration);
  });

  it("returns the transport unsubscribe and ignores events after unsubscribe", () => {
    const fixture = fakePreloadTransport();
    const api = createPreloadApi(fixture.transport);
    const listener = vi.fn();
    const unsubscribe = api.subscribe(listener);
    fixture.emit(validEvent(generation));
    unsubscribe();
    fixture.emit(validEvent(nextGeneration));

    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    void api.request({
      type: "project.pickExisting",
      payload: {},
      idempotencyKey: "pick-1"
    });
    expect(fixture.invocations[0]!.value.workerGeneration).toBe(generation);
  });

  it("exposes the narrow Electron bridge and removes its wrapped event listener", async () => {
    vi.mocked(ipcRenderer.invoke).mockImplementation(async (_channel, value) => (
      snapshotResponse(value as RendererRequestEnvelope)
    ));
    await import("../../src/preload/index");
    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledOnce();
    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledWith(
      "branchestra",
      expect.objectContaining({ request: expect.any(Function), subscribe: expect.any(Function) })
    );
    const api = vi.mocked(contextBridge.exposeInMainWorld).mock.calls[0]![1] as ReturnType<
      typeof createPreloadApi
    >;

    await api.request({
      type: "state.getSnapshot",
      payload: {},
      idempotencyKey: "snapshot-1"
    });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      "branchestra:request",
      expect.objectContaining({ type: "state.getSnapshot" })
    );

    const listener = vi.fn();
    const unsubscribe = api.subscribe(listener);
    expect(ipcRenderer.on).toHaveBeenCalledWith("branchestra:event", expect.any(Function));
    const wrapped = vi.mocked(ipcRenderer.on).mock.calls[0]![1];
    wrapped({} as Electron.IpcRendererEvent, validEvent());
    expect(listener).toHaveBeenCalledWith(validEvent());
    unsubscribe();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith("branchestra:event", wrapped);
  });
});
