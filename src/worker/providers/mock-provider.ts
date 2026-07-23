import type {
  TaskProviderEvent,
  TaskProviderPort,
  TaskProviderResumeRequest,
  TaskProviderRunHandle,
  TaskProviderRunRequest,
  TaskProviderRunResult
} from "../tasks/provider-port";

export type MockProviderStep =
  | TaskProviderEvent
  | { type: "waitForCancel" }
  | { type: "throw"; code: string; message: string };

export interface MockProviderScript {
  sessionId: string;
  steps: MockProviderStep[];
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  const pending = Promise.withResolvers<T>();
  return { promise: pending.promise, resolve: pending.resolve };
}

class BoundedAsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly readers: Array<Deferred<IteratorResult<T>>> = [];
  private readonly capacityWaiters: Array<Deferred<void>> = [];
  private closed = false;

  constructor(private readonly capacity: number) {}

  async push(value: T, signal: AbortSignal): Promise<boolean> {
    while (!this.closed && this.values.length >= this.capacity) {
      const available = deferred<void>();
      this.capacityWaiters.push(available);
      await Promise.race([
        available.promise,
        new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        })
      ]);
      if (signal.aborted) return false;
    }
    if (this.closed || signal.aborted) return false;
    const reader = this.readers.shift();
    if (reader) reader.resolve({ value, done: false });
    else this.values.push(value);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const reader of this.readers.splice(0)) {
      reader.resolve({ value: undefined, done: true });
    }
    for (const waiter of this.capacityWaiters.splice(0)) waiter.resolve();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) {
          this.capacityWaiters.shift()?.resolve();
          return { value, done: false };
        }
        if (this.closed) return { value: undefined, done: true };
        const reader = deferred<IteratorResult<T>>();
        this.readers.push(reader);
        return reader.promise;
      },
      return: async () => {
        this.close();
        return { value: undefined, done: true };
      }
    };
  }
}

interface MockRun {
  controller: AbortController;
  queue: BoundedAsyncQueue<TaskProviderEvent>;
  completion: Deferred<TaskProviderRunResult>;
  settled: boolean;
}

export class MockProvider implements TaskProviderPort {
  private readonly runs = new Map<string, MockRun>();
  private readonly blockedWaiters: Array<Deferred<void>> = [];
  private blockedRuns = 0;

  constructor(
    private readonly scriptForRun: (
      request: TaskProviderRunRequest | TaskProviderResumeRequest
    ) => MockProviderScript
  ) {}

  async startRun(request: TaskProviderRunRequest): Promise<TaskProviderRunHandle> {
    const script = this.scriptForRun(request);
    return this.createRun(request.runId, script.sessionId, script);
  }

  async resumeRun(request: TaskProviderResumeRequest): Promise<TaskProviderRunHandle> {
    const script = this.scriptForRun(request);
    return this.createRun(request.runId, request.providerSessionId, script);
  }

  async cancelRun(
    runId: string,
    reason: "user" | "quit" | "timeout"
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`MOCK_RUN_NOT_FOUND:${runId}`);
    if (run.settled || run.controller.signal.aborted) return;
    run.controller.abort();
    this.settle(run, {
      outcome: "cancelled",
      summary: `Cancelled: ${reason}`,
      error: null
    });
  }

  async waitUntilBlocked(): Promise<void> {
    if (this.blockedRuns > 0) return;
    const waiter = deferred<void>();
    this.blockedWaiters.push(waiter);
    await waiter.promise;
  }

  private createRun(
    runId: string,
    sessionId: string,
    script: MockProviderScript
  ): TaskProviderRunHandle {
    if (this.runs.has(runId)) throw new Error(`MOCK_RUN_ALREADY_EXISTS:${runId}`);
    const run: MockRun = {
      controller: new AbortController(),
      queue: new BoundedAsyncQueue<TaskProviderEvent>(16),
      completion: deferred<TaskProviderRunResult>(),
      settled: false
    };
    this.runs.set(runId, run);
    void this.executeScript(run, script);
    return {
      runId,
      sessionId,
      events: run.queue,
      completion: run.completion.promise
    };
  }

  private async executeScript(run: MockRun, script: MockProviderScript): Promise<void> {
    try {
      for (const step of script.steps) {
        if (run.controller.signal.aborted) return;
        if (step.type === "waitForCancel") {
          this.blockedRuns += 1;
          for (const waiter of this.blockedWaiters.splice(0)) waiter.resolve();
          await new Promise<void>((resolve) => {
            run.controller.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          this.blockedRuns -= 1;
          return;
        }
        if (step.type === "throw") {
          this.settle(run, {
            outcome: "failed",
            summary: step.message,
            error: { code: step.code, message: step.message }
          });
          return;
        }
        if (!await run.queue.push(step, run.controller.signal)) return;
        if (step.type === "run.completed") {
          this.settle(run, {
            outcome: "completed",
            summary: step.summary,
            error: null
          });
          return;
        }
        if (step.type === "run.failed") {
          this.settle(run, {
            outcome: "failed",
            summary: step.message,
            error: { code: step.code, message: step.message }
          });
          return;
        }
      }
      this.settle(run, {
        outcome: "completed",
        summary: "Mock script completed",
        error: null
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.settle(run, {
        outcome: "failed",
        summary: message,
        error: { code: "MOCK_PROVIDER_ERROR", message }
      });
    }
  }

  private settle(run: MockRun, result: TaskProviderRunResult): void {
    if (run.settled) return;
    run.settled = true;
    run.queue.close();
    run.completion.resolve(result);
  }
}
