import type { ProviderCapabilities, ProviderEvent, ProviderHealth, ProviderId, ProviderRunPayload } from "../../shared/contracts/provider";
import type { ProviderRunnerCommand } from "../../shared/contracts/provider-runner";
import { ProviderRunnerMessageSchema } from "../../shared/contracts/provider-runner";
import type { TaskProviderEvent, TaskProviderResumeRequest, TaskProviderRunHandle, TaskProviderRunRequest, TaskProviderRunResult } from "../tasks/provider-port";
import type { ProviderAdapter } from "./provider-adapter";

export interface RunnerHandle {
  send(command: ProviderRunnerCommand): Promise<void> | void;
  cancel?(reason: "user" | "quit" | "timeout"): Promise<void> | void;
}

export interface RunnerPort {
  launch(input: { runId: string; taskId: string; provider: ProviderId; worktreePath: string; executableRealpath: string; environment: Record<string, string> }, accept: (message: unknown) => Promise<void>): Promise<RunnerHandle>;
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) return { value, done: false };
        if (this.closed) return { value: undefined, done: true };
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
      return: async () => { this.close(); return { value: undefined, done: true }; },
    };
  }
}

export interface RunnerBackedAdapterDependencies {
  provider: ProviderId;
  capabilities: ProviderCapabilities;
  health: { list(): Promise<ProviderHealth[]> };
  codexConfigLockRealpath(): Promise<string>;
  runner: RunnerPort;
  normalize(raw: unknown, run: { runId: string; providerSeq: number; occurredAt: string }): ProviderEvent[];
  now(): string;
  environmentFor?(health: ProviderHealth, request: TaskProviderRunRequest): Record<string, string>;
  repository?: {
    appendRawEvent(input: { id: string; runId: string; providerSeq: number; payload: unknown; receivedAt: string }): boolean;
    upsertSession(record: { runId: string; provider: ProviderId; providerSessionId: string; contextHash: string; lastProviderSeq: number; resumeState: "active"; updatedAt: string }): void;
  };
  handleToolCall?(input: { runId: string; callId: string; request: unknown; taskRequest: TaskProviderRunRequest }): Promise<{ content: string; truncated: boolean }>;
}

interface ActiveRun { runner: RunnerHandle; queue: AsyncEventQueue<TaskProviderEvent>; settle(result: TaskProviderRunResult): void }
const PROVIDER_SESSION_START_TIMEOUT_MS = 30_000;

function runnerContextHash(value: string): string {
  const hash = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("PROVIDER_CONTEXT_HASH_INVALID");
  return hash;
}

export class RunnerBackedAdapter implements ProviderAdapter {
  readonly provider: ProviderId;
  private readonly active = new Map<string, ActiveRun>();

  constructor(private readonly deps: RunnerBackedAdapterDependencies) {
    this.provider = deps.provider;
  }

  async detect(): Promise<ProviderHealth> {
    const health = (await this.deps.health.list()).find((item) => item.provider === this.provider);
    if (!health) throw new Error(`PROVIDER_HEALTH_MISSING:${this.provider}`);
    return health;
  }

  async probeCapabilities(executableRealpath: string): Promise<ProviderCapabilities> {
    const health = await this.detect();
    if (health.executableRealpath !== executableRealpath || health.state !== "ready") throw new Error(`PROVIDER_NOT_READY:${this.provider}:${health.state}`);
    return this.deps.capabilities;
  }

  async getAuthStatus(executableRealpath: string): Promise<ProviderHealth["state"]> {
    const health = await this.detect();
    return health.executableRealpath === executableRealpath ? health.state : "missing";
  }

  normalizeEvent(raw: unknown, run: { runId: string; providerSeq: number; occurredAt: string }): ProviderEvent[] {
    return this.deps.normalize(raw, run);
  }

  startRun(request: TaskProviderRunRequest): Promise<TaskProviderRunHandle> {
    return this.start(request, null);
  }

  resumeRun(request: TaskProviderResumeRequest): Promise<TaskProviderRunHandle> {
    return this.start(request, request.providerSessionId);
  }

  async cancelRun(runId: string, reason: "user" | "quit" | "timeout"): Promise<void> {
    const active = this.active.get(runId);
    if (!active) return;
    await active.runner.cancel?.(reason);
    active.settle({ outcome: "cancelled", summary: `Cancelled: ${reason}`, error: null });
  }

  private async start(request: TaskProviderRunRequest | TaskProviderResumeRequest, providerSessionId: string | null): Promise<TaskProviderRunHandle> {
    if (request.provider !== this.provider) throw new Error(`PROVIDER_MISMATCH:${request.provider}:${this.provider}`);
    if (this.active.has(request.runId)) throw new Error(`PROVIDER_RUN_ALREADY_ACTIVE:${request.runId}`);
    const health = await this.detect();
    if (health.state !== "ready" || !health.executableRealpath) throw new Error(`PROVIDER_NOT_READY:${this.provider}:${health.state}`);
    const contextHash = runnerContextHash(request.contextHash);
    const environment = this.deps.environmentFor?.(health, request) ?? { HOME: process.env.HOME ?? "/", PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
    const queue = new AsyncEventQueue<TaskProviderEvent>();
    const completion = Promise.withResolvers<TaskProviderRunResult>();
    const sessionStarted = Promise.withResolvers<string>();
    let observedSessionId = providerSessionId;
    let settled = false;
    let runner: RunnerHandle | null = null;
    const settle = (result: TaskProviderRunResult): void => {
      if (settled) return;
      settled = true;
      this.active.delete(request.runId);
      queue.close();
      completion.resolve(result);
    };
    const accept = async (rawMessage: unknown): Promise<void> => {
      const message = ProviderRunnerMessageSchema.parse(rawMessage);
      if (message.runId !== request.runId) throw new Error("Provider runner message run ID mismatch");
      if (message.type === "provider.raw") {
        const inserted = this.deps.repository?.appendRawEvent({
          id: `${message.runId}:${message.providerSeq}`,
          runId: message.runId,
          providerSeq: message.providerSeq,
          payload: message.payload,
          receivedAt: message.receivedAt,
        });
        if (inserted === false) return;
        for (const event of this.normalizeEvent(message.payload, { runId: message.runId, providerSeq: message.providerSeq, occurredAt: message.receivedAt })) {
          if (event.type === "session.started") {
            observedSessionId = event.sessionId;
            sessionStarted.resolve(event.sessionId);
            this.deps.repository?.upsertSession({
              runId: request.runId,
              provider: this.provider,
              providerSessionId: event.sessionId,
              contextHash,
              lastProviderSeq: event.providerSeq,
              resumeState: "active",
              updatedAt: event.occurredAt,
            });
          }
          const taskEvent = toTaskEvent(event);
          if (taskEvent) queue.push(taskEvent);
          if (event.type === "run.completed") settle({ outcome: "completed", summary: event.result, error: null });
          if (event.type === "run.failed") settle({ outcome: "failed", summary: event.message, error: { code: event.code, message: event.message } });
        }
      } else if (message.type === "tool.call") {
        if (!runner) throw new Error("Provider runner transport is unavailable");
        const result = this.deps.handleToolCall
          ? await this.deps.handleToolCall({ runId: message.runId, callId: message.callId, request: message.request, taskRequest: request })
          : { content: JSON.stringify({ error: "Read-only tool bridge is unavailable" }), truncated: false };
        await runner.send({ type: "tool.result", runId: message.runId, callId: message.callId, result });
      } else if (message.type === "run.failed") {
        const event = { type: "run.failed" as const, code: message.code, message: message.message };
        queue.push(event);
        settle({ outcome: "failed", summary: message.message, error: { code: message.code, message: message.message } });
      } else if (message.type === "run.cancelled") {
        settle({ outcome: "cancelled", summary: "Provider run cancelled", error: null });
      } else if (message.type === "run.completed" && !settled) {
        queue.push({ type: "run.completed", summary: "Provider run completed" });
        settle({ outcome: "completed", summary: "Provider run completed", error: null });
      }
    };
    runner = await this.deps.runner.launch({ runId: request.runId, taskId: request.taskId, provider: this.provider, worktreePath: request.worktreePath, executableRealpath: health.executableRealpath, environment }, accept);
    this.active.set(request.runId, { runner, queue, settle });
    const payload: ProviderRunPayload = {
      taskId: request.taskId,
      roomId: request.roomId,
      role: request.role === "lead" ? "lead" : "collaborator",
      instruction: "recoveryBrief" in request ? `${request.recoveryBrief}\n\n${request.instruction}` : request.instruction,
      worktreePath: request.worktreePath,
      contextVersion: request.contextVersion,
      contextHash,
      approvedCapabilities: request.approvedCapabilities,
      deniedWriteRoots: [],
      environment,
    };
    const codexConfigLockRealpath = this.provider === "codex" ? await this.deps.codexConfigLockRealpath() : null;
    const command: ProviderRunnerCommand = providerSessionId
      ? { type: "run.resume", runId: request.runId, provider: this.provider, executableRealpath: health.executableRealpath, codexConfigLockRealpath, providerSessionId, request: payload }
      : { type: "run.start", runId: request.runId, provider: this.provider, executableRealpath: health.executableRealpath, codexConfigLockRealpath, request: payload };
    try {
      await runner.send(command);
      if (observedSessionId === null) {
        const timeout = Promise.withResolvers<never>();
        const timer = setTimeout(
          () => timeout.reject(new Error(`PROVIDER_SESSION_START_TIMEOUT:${this.provider}`)),
          Math.max(1, Math.min(request.approvedCapabilities.maxRunMs, PROVIDER_SESSION_START_TIMEOUT_MS))
        );
        void completion.promise.then(() => {
          timeout.reject(new Error(`PROVIDER_SESSION_MISSING:${this.provider}`));
        });
        try {
          observedSessionId = await Promise.race([sessionStarted.promise, timeout.promise]);
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (error) {
      await Promise.resolve(runner.cancel?.("timeout")).catch(() => undefined);
      settle({
        outcome: "failed",
        summary: error instanceof Error ? error.message : String(error),
        error: { code: "provider_error", message: error instanceof Error ? error.message : String(error) }
      });
      throw error;
    }
    return { runId: request.runId, sessionId: observedSessionId, events: queue, completion: completion.promise };
  }
}

function toTaskEvent(event: ProviderEvent): TaskProviderEvent | null {
  switch (event.type) {
    case "assistant.delta":
    case "assistant.completed": return { type: "assistant.message", text: event.text };
    case "item.snapshot": return event.itemType === "agent_message" && event.status === "completed" ? { type: "assistant.message", text: event.summary } : null;
    case "run.completed": return { type: "run.completed", summary: event.result };
    case "run.failed": return { type: "run.failed", code: event.code, message: event.message };
    default: return null;
  }
}
