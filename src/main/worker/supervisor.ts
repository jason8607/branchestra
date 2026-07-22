import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  WorkerEventEnvelopeSchema,
  WorkerRequestEnvelopeSchema,
  WorkerResponseEnvelopeSchema,
  type WorkerEventEnvelope,
  type WorkerRequestEnvelope,
  type WorkerResponseEnvelope
} from "../../shared/contracts/protocol";
import type { UtilityProcessAdapter, UtilityProcessChild } from "./utility-process-adapter";

export type { UtilityProcessAdapter, UtilityProcessChild } from "./utility-process-adapter";

export interface WorkerReady {
  workerGeneration: string;
}

export interface WorkerSupervisor {
  start(): Promise<WorkerReady>;
  request(request: WorkerRequestEnvelope): Promise<WorkerResponseEnvelope>;
  subscribe(listener: (event: WorkerEventEnvelope) => void): () => void;
  stop(deadlineMs: number): Promise<void>;
  getGeneration(): string | null;
}

export interface WorkerSupervisorDependencies {
  utilityProcess: UtilityProcessAdapter;
  workerEntry: string;
  dbPath: string;
  ownerInstanceId: string;
  nextGeneration: () => string;
  restartBackoffMs: readonly number[];
  schedule(delayMs: number, callback: () => void): () => void;
  environment?: Record<string, string | undefined>;
}

export function createWorkerSupervisor(dependencies: WorkerSupervisorDependencies): WorkerSupervisor {
  type ActiveChild = {
    process: UtilityProcessChild;
    generation: string;
    cancelHandshakeTimeout: () => void;
    cancelStableReset: () => void;
    failed: boolean;
  };

  let active: ActiveChild | null = null;
  let generation: string | null = null;
  let state: "idle" | "starting" | "ready" | "stopping" | "stopped" = "idle";
  let startPromise: Promise<WorkerReady> | null = null;
  let resolveStart: ((ready: WorkerReady) => void) | null = null;
  let restartIndex = 0;
  let cancelRestart: (() => void) | null = null;
  let stopPromise: Promise<void> | null = null;
  const listeners = new Set<(event: WorkerEventEnvelope) => void>();
  const pending = new Map<string, {
    resolve: (response: WorkerResponseEnvelope) => void;
    reject: (error: Error) => void;
  }>();

  const emit = (event: WorkerEventEnvelope): void => {
    for (const listener of listeners) listener(event);
  };

  const scheduleReplacement = (): void => {
    if (state === "stopping" || state === "stopped" || cancelRestart !== null) return;
    const lastIndex = dependencies.restartBackoffMs.length - 1;
    const delayMs = dependencies.restartBackoffMs[Math.min(restartIndex, lastIndex)];
    if (delayMs === undefined) return;
    restartIndex = Math.min(restartIndex + 1, lastIndex);
    cancelRestart = dependencies.schedule(delayMs, () => {
      cancelRestart = null;
      spawn();
    });
  };

  const fail = (
    target: ActiveChild,
    reason: string,
    kill: boolean,
    emitDisconnected = true
  ): void => {
    if (target.failed || active !== target || state === "stopping" || state === "stopped") return;
    target.failed = true;
    target.cancelHandshakeTimeout();
    target.cancelStableReset();
    if (kill) target.process.kill();
    for (const correlation of pending.values()) {
      correlation.reject(new Error(`Worker disconnected: ${reason}`));
    }
    pending.clear();
    if (emitDisconnected) {
      emit(WorkerEventEnvelopeSchema.parse({
        v: PROTOCOL_VERSION,
        requestId: randomUUID(),
        idempotencyKey: `worker-disconnected:${target.generation}`,
        workerGeneration: target.generation,
        type: "worker.disconnected",
        payload: { reason }
      }));
    }
    active = null;
    generation = null;
    state = "starting";
    scheduleReplacement();
  };

  const spawn = (): void => {
    generation = dependencies.nextGeneration();
    const expectedGeneration = generation;
    const environment = dependencies.environment ?? process.env;
    const env: Record<string, string> = {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      BRANCHESTRA_DB_PATH: dependencies.dbPath,
      BRANCHESTRA_OWNER_INSTANCE_ID: dependencies.ownerInstanceId,
      BRANCHESTRA_WORKER_GENERATION: expectedGeneration,
      BRANCHESTRA_WORKER_START_IDENTITY: randomUUID()
    };
    for (const name of ["LANG", "LC_ALL", "TMPDIR"] as const) {
      const value = environment[name];
      if (value !== undefined) env[name] = value;
    }
    const childProcess = dependencies.utilityProcess.fork(dependencies.workerEntry, { env });
    const target: ActiveChild = {
      process: childProcess,
      generation: expectedGeneration,
      cancelHandshakeTimeout: () => undefined,
      cancelStableReset: () => undefined,
      failed: false
    };
    active = target;
    state = "starting";
    target.cancelHandshakeTimeout = dependencies.schedule(
      5_000,
      () => fail(target, "handshake-timeout", true)
    );
    childProcess.onMessage((value) => {
      if (active !== target) return;
      const parsedResponse = WorkerResponseEnvelopeSchema.safeParse(value);
      if (parsedResponse.success && parsedResponse.data.workerGeneration === expectedGeneration) {
        const correlation = pending.get(parsedResponse.data.requestId);
        if (correlation !== undefined) {
          pending.delete(parsedResponse.data.requestId);
          correlation.resolve(parsedResponse.data);
        }
        return;
      }
      const parsed = WorkerEventEnvelopeSchema.safeParse(value);
      if (!parsed.success || parsed.data.workerGeneration !== expectedGeneration) return;
      if (parsed.data.type === "worker.rejected") {
        emit(parsed.data);
        fail(target, "lease-held", true, false);
        return;
      }
      if (
        parsed.data.type === "worker.ready" &&
        parsed.data.v === PROTOCOL_VERSION &&
        parsed.data.payload.protocolVersion === PROTOCOL_VERSION &&
        parsed.data.workerGeneration === expectedGeneration
      ) {
        target.cancelHandshakeTimeout();
        state = "ready";
        resolveStart?.({ workerGeneration: expectedGeneration });
        resolveStart = null;
        target.cancelStableReset = dependencies.schedule(5_000, () => {
          if (active === target && state === "ready") restartIndex = 0;
        });
      }
      emit(parsed.data);
    });
    childProcess.onExit((code) => fail(target, `exit:${code}`, false));
  };

  return {
    start() {
      if (startPromise === null) {
        startPromise = new Promise((resolve) => {
          resolveStart = resolve;
        });
        spawn();
      }
      return startPromise;
    },
    request(request) {
      if (state !== "ready" || active === null || request.workerGeneration !== generation) {
        return Promise.reject(new Error("Worker is not ready"));
      }
      const parsed = WorkerRequestEnvelopeSchema.safeParse(request);
      if (!parsed.success) return Promise.reject(new Error("Worker request is invalid"));
      return new Promise((resolve, reject) => {
        pending.set(parsed.data.requestId, { resolve, reject });
        try {
          active!.process.postMessage(parsed.data);
        } catch (error) {
          pending.delete(parsed.data.requestId);
          reject(error instanceof Error ? error : new Error("Failed to post worker request"));
        }
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop(deadlineMs) {
      if (stopPromise !== null) return stopPromise;
      stopPromise = (async () => {
        state = "stopping";
        cancelRestart?.();
        cancelRestart = null;
        const target = active;
        target?.cancelHandshakeTimeout();
        target?.cancelStableReset();
        for (const correlation of pending.values()) {
          correlation.reject(new Error("Worker supervisor is stopping"));
        }
        pending.clear();
        if (target === null || generation === null) {
          active = null;
          generation = null;
          state = "stopped";
          return;
        }

        const requestId = randomUUID();
        const request = WorkerRequestEnvelopeSchema.parse({
          v: PROTOCOL_VERSION,
          requestId,
          idempotencyKey: `worker-prepare-quit:${requestId}`,
          workerGeneration: target.generation,
          type: "worker.prepareQuit",
          payload: { deadlineMs }
        });
        let cancelDeadline: () => void = () => undefined;
        const deadline = new Promise<boolean>((resolve) => {
          cancelDeadline = dependencies.schedule(
            Math.max(0, deadlineMs - Date.now()),
            () => resolve(false)
          );
        });
        const response = new Promise<WorkerResponseEnvelope>((resolve, reject) => {
          pending.set(requestId, { resolve, reject });
        });
        let posted = true;
        try {
          target.process.postMessage(request);
        } catch {
          posted = false;
        }
        const prepared = posted
          ? await Promise.race([
              response.then((envelope) => (
                envelope.payload.ok &&
                envelope.payload.requestType === "worker.prepareQuit" &&
                "prepared" in envelope.payload.data &&
                envelope.payload.data.prepared
              )).catch(() => false),
              deadline
            ])
          : false;
        pending.delete(requestId);
        if (prepared) cancelDeadline();
        else {
          try {
            target.process.kill();
          } catch {
            // Shutdown is complete even if the process has already exited.
          }
        }
        active = null;
        generation = null;
        state = "stopped";
      })();
      return stopPromise;
    },
    getGeneration() {
      return generation;
    }
  };
}
