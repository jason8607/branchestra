import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RoomEventSchema } from "../shared/contracts/domain";
import {
  assertEnvelopeSize,
  PROTOCOL_VERSION,
  WorkerEventEnvelopeSchema,
  WorkerRequestEnvelopeSchema,
  WorkerResponseEnvelopeSchema,
  ZERO_WORKER_GENERATION
} from "../shared/contracts/protocol";
import { createProjectService } from "./domain/project-service";
import { createRoomService } from "./domain/room-service";
import { inspectExistingRepository } from "./git/inspect-repository";
import { createCommandHandlers } from "./protocol/handlers";
import { createWorkerRouter } from "./protocol/worker-router";
import { openDatabase } from "./storage/database";
import { createEventStore } from "./storage/event-store";
import { createIdempotencyStore } from "./storage/idempotency-store";
import { runMigrations } from "./storage/migrations";
import { createRepositories } from "./storage/repositories";
import { createWorkerLeaseStore, type WorkerIdentity } from "./storage/worker-lease-store";

export interface WorkerPort {
  postMessage(value: unknown): void;
  onMessage(listener: (value: unknown) => void): () => void;
}

export interface WorkerStartOptions {
  dbPath: string;
  port: WorkerPort;
  identity: WorkerIdentity;
  leaseTtlMs: number;
  heartbeatIntervalMs: number;
}

export interface WorkerRuntime {
  prepareQuit(deadlineMs: number): Promise<void>;
}

type LifecycleState = "starting" | "active" | "stopped";

const SafeCorrelationSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  requestId: z.string().uuid(),
  idempotencyKey: z.string().min(1).max(128),
  workerGeneration: z.string().uuid().refine((value) => value !== ZERO_WORKER_GENERATION),
  type: z.string().min(1)
}).passthrough();

function handshakeEnvelope(
  type: "worker.ready" | "worker.rejected",
  identity: WorkerIdentity
): unknown {
  return WorkerEventEnvelopeSchema.parse({
    v: PROTOCOL_VERSION,
    requestId: randomUUID(),
    idempotencyKey: `worker-handshake:${identity.workerGeneration}`,
    workerGeneration: identity.workerGeneration,
    type,
    payload: type === "worker.ready"
      ? { protocolVersion: PROTOCOL_VERSION }
      : { code: "LEASE_HELD" }
  });
}

function invalidRequestResponse(value: unknown): unknown | undefined {
  const correlation = SafeCorrelationSchema.safeParse(value);
  if (!correlation.success) return undefined;
  const { v, requestId, idempotencyKey, workerGeneration, type } = correlation.data;
  return WorkerResponseEnvelopeSchema.parse({
    v,
    requestId,
    idempotencyKey,
    workerGeneration,
    type: "response",
    payload: {
      ok: false,
      requestType: type,
      code: "INVALID_REQUEST",
      message: "Worker request is invalid"
    }
  });
}

function stoppedRuntime(): WorkerRuntime {
  return { prepareQuit: async () => undefined };
}

export async function startWorker(options: WorkerStartOptions): Promise<WorkerRuntime> {
  const database = openDatabase(options.dbPath);
  runMigrations(database);
  const leaseStore = createWorkerLeaseStore(database);
  if (leaseStore.acquire(options.identity, Date.now(), options.leaseTtlMs) === "held") {
    try {
      options.port.postMessage(handshakeEnvelope("worker.rejected", options.identity));
    } finally {
      try {
        database.close();
      } catch {
        // A rejected worker owns no lease; preserve a handshake posting failure if present.
      }
    }
    return stoppedRuntime();
  }

  let lifecycle: LifecycleState = "starting";
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stop = (): void => {
    if (lifecycle === "stopped") return;
    lifecycle = "stopped";
    const cleanup = [
      () => unsubscribe?.(),
      () => {
        unsubscribe = undefined;
      },
      () => {
        if (heartbeat !== undefined) clearInterval(heartbeat);
        heartbeat = undefined;
      },
      () => leaseStore.release(options.identity),
      () => database.close()
    ];
    for (const operation of cleanup) {
      try {
        operation();
      } catch {
        // Shutdown must continue through every cleanup operation.
      }
    }
  };
  const stopQuietly = (): void => {
    try {
      stop();
    } catch {
      // Keep timer and message callback errors contained even if a future cleanup changes.
    }
  };
  const isStopped = (): boolean => lifecycle === "stopped";
  const runtime: WorkerRuntime = {
    async prepareQuit(deadlineMs) {
      if (Date.now() >= deadlineMs) {
        stopQuietly();
        return;
      }
      stopQuietly();
    }
  };

  try {
    const repositories = createRepositories(database);
    const eventStore = createEventStore(database, repositories);
    const idempotencyStore = createIdempotencyStore(database, () => new Date().toISOString());
    const ids = { next: randomUUID };
    const clock = { now: () => new Date().toISOString() };
    const projectService = createProjectService({
      repositories,
      idempotencyStore,
      inspectRepository: inspectExistingRepository,
      clock,
      ids
    });
    const roomService = createRoomService({ repositories, eventStore, idempotencyStore, clock, ids });
    const router = createWorkerRouter({
      workerGeneration: options.identity.workerGeneration,
      handlers: createCommandHandlers({ projectService, roomService, prepareQuit: runtime.prepareQuit })
    });
    const onMessage = (value: unknown): void => {
      void (async () => {
        if (lifecycle === "stopped") return;
        let request: z.infer<typeof WorkerRequestEnvelopeSchema>;
        try {
          assertEnvelopeSize(value);
          request = WorkerRequestEnvelopeSchema.parse(value);
        } catch {
          const response = invalidRequestResponse(value);
          if (response === undefined) {
            stopQuietly();
            return;
          }
          try {
            options.port.postMessage(response);
          } catch {
            stopQuietly();
          }
          return;
        }

        try {
          const response = WorkerResponseEnvelopeSchema.parse(await router(request));
          options.port.postMessage(response);
          if (response.payload.ok && response.payload.requestType === "message.post" && !response.payload.replayed) {
            const event = RoomEventSchema.parse(response.payload.data);
            options.port.postMessage(WorkerEventEnvelopeSchema.parse({
              v: PROTOCOL_VERSION,
              requestId: request.requestId,
              idempotencyKey: event.id,
              workerGeneration: options.identity.workerGeneration,
              type: "room.event",
              payload: event
            }));
          }
        } catch {
          stopQuietly();
        }
      })().catch(() => stopQuietly());
    };

    unsubscribe = options.port.onMessage(onMessage);
    if (isStopped()) {
      try {
        unsubscribe?.();
      } catch {
        // The worker is already stopped; a late subscription must not escape startup.
      }
      unsubscribe = undefined;
      return runtime;
    }
    heartbeat = setInterval(() => {
      try {
        if (!leaseStore.heartbeat(options.identity, Date.now())) stopQuietly();
      } catch {
        stopQuietly();
      }
    }, options.heartbeatIntervalMs);
    if (isStopped()) return runtime;
    options.port.postMessage(handshakeEnvelope("worker.ready", options.identity));
    if (lifecycle === "starting") lifecycle = "active";
    return runtime;
  } catch (error) {
    stopQuietly();
    throw error;
  }
}
