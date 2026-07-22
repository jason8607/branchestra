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
  reportError(error: unknown): void;
}

export function installApplicationLifecycle(dependencies: LifecycleDependencies): void {
  if (!dependencies.app.requestSingleInstanceLock()) {
    dependencies.app.quit();
    return;
  }

  let allowQuit = false;
  let quitPromise: Promise<void> | null = null;
  const reportError = (error: unknown): void => {
    try {
      dependencies.reportError(error);
    } catch {
      // Error reporting must not create another unhandled lifecycle failure.
    }
  };
  dependencies.app.on("second-instance", () => dependencies.focusWindow());
  dependencies.app.on("window-all-closed", () => dependencies.app.quit());
  const requestQuit = (): void => {
    if (quitPromise !== null) return;
    const deadlineMs = Date.now() + dependencies.quitTimeoutMs;
    quitPromise = dependencies.supervisor.stop(deadlineMs)
      .catch(reportError)
      .finally(() => {
        allowQuit = true;
        dependencies.app.quit();
      });
  };
  dependencies.app.on("before-quit", (...args) => {
    if (allowQuit) return;
    const event = args[0] as PreventableApplicationEvent;
    event.preventDefault();
    requestQuit();
  });
  void dependencies.app.whenReady().then(async () => {
    await dependencies.supervisor.start();
    await dependencies.createWindow();
  }).catch((error: unknown) => {
    reportError(error);
    requestQuit();
  });
}
