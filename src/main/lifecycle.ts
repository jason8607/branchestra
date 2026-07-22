import type { WorkerSupervisor } from "./worker/supervisor";

export interface PreventableApplicationEvent {
  preventDefault(): void;
}

export interface LifecycleApplication {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  whenReady(): Promise<unknown>;
  on(name: string, listener: (...args: unknown[]) => void): void;
}

export interface LifecycleDependencies {
  app: LifecycleApplication;
  supervisor: Pick<WorkerSupervisor, "start" | "stop">;
  createWindow(): Promise<unknown>;
  focusWindow(): void;
  quitTimeoutMs: number;
}

export function installApplicationLifecycle(dependencies: LifecycleDependencies): void {
  if (!dependencies.app.requestSingleInstanceLock()) {
    dependencies.app.quit();
    return;
  }

  let allowQuit = false;
  let quitPromise: Promise<void> | null = null;
  dependencies.app.on("second-instance", () => dependencies.focusWindow());
  dependencies.app.on("before-quit", (...args) => {
    if (allowQuit) return;
    const event = args[0] as PreventableApplicationEvent;
    event.preventDefault();
    if (quitPromise !== null) return;
    const deadlineMs = Date.now() + dependencies.quitTimeoutMs;
    quitPromise = dependencies.supervisor.stop(deadlineMs).finally(() => {
      allowQuit = true;
      dependencies.app.quit();
    });
  });
  void dependencies.app.whenReady().then(async () => {
    await dependencies.supervisor.start();
    await dependencies.createWindow();
  });
}
