import { randomUUID } from "node:crypto";
import {
  assertEnvelopeSize,
  PROTOCOL_VERSION,
  WorkerEventEnvelopeSchema,
  WorkerRequestEnvelopeSchema,
  WorkerResponseEnvelopeSchema
} from "../shared/contracts/protocol";
import { RoomEventSchema } from "../shared/contracts/domain";
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

function stoppedRuntime(): WorkerRuntime {
  return { prepareQuit: async () => undefined };
}

export async function startWorker(options: WorkerStartOptions): Promise<WorkerRuntime> {
  const database = openDatabase(options.dbPath);
  runMigrations(database);
  const leaseStore = createWorkerLeaseStore(database);
  if (leaseStore.acquire(options.identity, Date.now(), options.leaseTtlMs) === "held") {
    options.port.postMessage(handshakeEnvelope("worker.rejected", options.identity));
    database.close();
    return stoppedRuntime();
  }

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

  let stopped = false;
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    unsubscribe?.();
    unsubscribe = undefined;
    if (heartbeat !== undefined) clearInterval(heartbeat);
    heartbeat = undefined;
    try {
      leaseStore.release(options.identity);
    } finally {
      database.close();
    }
  };
  const runtime: WorkerRuntime = {
    async prepareQuit(deadlineMs) {
      if (Date.now() >= deadlineMs) {
        stop();
        return;
      }
      stop();
    }
  };
  const router = createWorkerRouter({
    workerGeneration: options.identity.workerGeneration,
    handlers: createCommandHandlers({ projectService, roomService, prepareQuit: runtime.prepareQuit })
  });

  unsubscribe = options.port.onMessage((value) => {
    void (async () => {
      if (stopped) return;
      assertEnvelopeSize(value);
      const request = WorkerRequestEnvelopeSchema.parse(value);
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
    })();
  });
  heartbeat = setInterval(() => {
    if (!leaseStore.heartbeat(options.identity, Date.now())) stop();
  }, options.heartbeatIntervalMs);
  options.port.postMessage(handshakeEnvelope("worker.ready", options.identity));
  return runtime;
}
