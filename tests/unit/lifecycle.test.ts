import { describe, expect, it, vi } from "vitest";
import { resolveBootstrapPaths } from "../../src/main/bootstrap";
import { installApplicationLifecycle, type LifecycleDependencies } from "../../src/main/lifecycle";

vi.mock("electron", () => ({
  app: {},
  BrowserWindow: class BrowserWindow {},
  utilityProcess: { fork: vi.fn() }
}));

interface PreventableEvent {
  preventDefault(): void;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function lifecycleFixture(options: { lock: boolean }) {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const ready = deferred();
  const stopped = deferred();
  const app = {
    requestSingleInstanceLock: vi.fn(() => options.lock),
    quit: vi.fn(),
    whenReady: vi.fn(() => ready.promise),
    on: vi.fn((name: string, listener: (...args: unknown[]) => void) => {
      const registered = listeners.get(name) ?? [];
      registered.push(listener);
      listeners.set(name, registered);
    })
  };
  const supervisor = {
    start: vi.fn(async () => ({ workerGeneration: "50000000-0000-4000-8000-000000000001" })),
    stop: vi.fn(() => stopped.promise),
    request: vi.fn(),
    subscribe: vi.fn(),
    getGeneration: vi.fn()
  };
  const createWindow = vi.fn(async () => undefined);
  const focusWindow = vi.fn();
  const dependencies: LifecycleDependencies = {
    app,
    supervisor,
    createWindow,
    focusWindow,
    quitTimeoutMs: 5_000
  };
  const emit = (name: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(name) ?? []) listener(...args);
  };
  return {
    app,
    supervisor,
    createWindow,
    focusWindow,
    dependencies,
    async emitReady() {
      ready.resolve();
      await ready.promise;
      await Promise.resolve();
      await Promise.resolve();
    },
    emitBeforeQuit(): PreventableEvent {
      const event = { preventDefault: vi.fn() };
      emit("before-quit", event);
      return event;
    },
    emitSecondInstance() {
      emit("second-instance");
    },
    async finishStop() {
      stopped.resolve();
      await stopped.promise;
      await Promise.resolve();
      await Promise.resolve();
    }
  };
}

describe("application lifecycle", () => {
  it("resolves the built worker beside Main output", () => {
    expect(resolveBootstrapPaths("file:///app/out/main/bootstrap.js", "/data/user")).toEqual({
      workerEntry: "/app/out/main/worker.js",
      dbPath: "/data/user/branchestra.sqlite3",
      preloadEntry: "/app/out/preload/index.js",
      rendererEntry: "/app/out/renderer/index.html"
    });
  });

  it("does not start a worker or window without the single-instance lock", () => {
    const fixture = lifecycleFixture({ lock: false });
    installApplicationLifecycle(fixture.dependencies);
    expect(fixture.app.quit).toHaveBeenCalledOnce();
    expect(fixture.supervisor.start).not.toHaveBeenCalled();
    expect(fixture.createWindow).not.toHaveBeenCalled();
  });

  it("starts the worker before creating a window and focuses it for a second instance", async () => {
    const fixture = lifecycleFixture({ lock: true });
    installApplicationLifecycle(fixture.dependencies);
    await fixture.emitReady();
    fixture.emitSecondInstance();

    expect(fixture.supervisor.start).toHaveBeenCalledOnce();
    expect(fixture.createWindow).toHaveBeenCalledOnce();
    expect(fixture.supervisor.start.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.createWindow.mock.invocationCallOrder[0]!
    );
    expect(fixture.focusWindow).toHaveBeenCalledOnce();
  });

  it("runs one worker quit handshake when before-quit is emitted twice", async () => {
    const fixture = lifecycleFixture({ lock: true });
    installApplicationLifecycle(fixture.dependencies);
    await fixture.emitReady();
    const first = fixture.emitBeforeQuit();
    const second = fixture.emitBeforeQuit();
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(fixture.supervisor.stop).toHaveBeenCalledOnce();
    await fixture.finishStop();
    expect(fixture.app.quit).toHaveBeenCalledOnce();
  });
});
