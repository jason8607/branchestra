import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { mkdir, realpath } from "node:fs/promises";
import { z } from "zod";
import { hashCanonical } from "./approvals/canonical-json";
import { FinalApprovalService, GitCandidateTupleSource } from "./approvals/final-approval-service";
import { ApprovedCommandRunner } from "./approvals/approved-command-runner";
import { RoomEventSchema } from "../shared/contracts/domain";
import {
  assertEnvelopeSize,
  PROTOCOL_VERSION,
  WorkerEventEnvelopeSchema,
  WorkerRequestEnvelopeSchema,
  WorkerResponseEnvelopeSchema,
  postEnvelope
} from "../shared/contracts/protocol";
import { createProjectService } from "./domain/project-service";
import { createRoomService } from "./domain/room-service";
import { inspectExistingRepository } from "./git/inspect-repository";
import { GitCommandRunner } from "./git/git-command-runner";
import { GitArtifactRepository } from "./git/git-artifact-repository";
import { GitManager } from "./git/git-manager";
import { GitOperationReconciler } from "./git/git-operation-reconciler";
import { MergeService } from "./git/merge-service";
import { GitReadService } from "./git/repository-inspector";
import { JournaledOperationRunner } from "./operations/journaled-operation-runner";
import { JournaledProcessRunner } from "./operations/journaled-process-runner";
import { RepositoryLock } from "./operations/repository-lock";
import { createDefaultTaskProvider } from "./providers/unavailable-provider";
import { MockProvider } from "./providers/mock-provider";
import { e2eMockScript, type E2EMockScenario } from "./providers/e2e-mock-scenarios";
import { createCommandHandlers } from "./protocol/handlers";
import { createWorkerRouter } from "./protocol/worker-router";
import { openDatabase } from "./storage/database";
import { createEventStore, setTaskSnapshotSource } from "./storage/event-store";
import { createIdempotencyStore } from "./storage/idempotency-store";
import { runMigrations } from "./storage/migrations";
import { createRepositories } from "./storage/repositories";
import { createWorkerLeaseStore, type WorkerIdentity } from "./storage/worker-lease-store";
import { TaskService } from "./tasks/task-service";
import { createTaskExecutionServices } from "./tasks/task-execution-services";
import { CandidateService } from "./tasks/candidate-service";
import { E2EMockWorkflow } from "./tasks/e2e-mock-workflow";
import { RecoveryCoordinator } from "./tasks/recovery-coordinator";
import { createTaskCommandHandlers, TaskInspectorQuery } from "./tasks/task-command-handlers";

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
  e2eMock?: {
    enabled: true;
    scenario: E2EMockScenario;
  };
}

export interface WorkerRuntime {
  prepareQuit(deadlineMs: number): Promise<void>;
}

type LifecycleState = "starting" | "active" | "stopped";

const SafeCorrelationSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  requestId: z.string().uuid(),
  idempotencyKey: z.string().min(1).max(128),
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

function invalidRequestResponse(value: unknown, activeWorkerGeneration: string): unknown | undefined {
  const correlation = SafeCorrelationSchema.safeParse(value);
  if (!correlation.success) return undefined;
  const { v, requestId, idempotencyKey, type } = correlation.data;
  return WorkerResponseEnvelopeSchema.parse({
    v,
    requestId,
    idempotencyKey,
    workerGeneration: activeWorkerGeneration,
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
  if (options.e2eMock && options.e2eMock.enabled !== true) throw new Error("MOCK_PROVIDER_DISABLED");
  const database = openDatabase(options.dbPath);
  let leaseHeld = false;
  const leaseStore = (() => {
    try {
      runMigrations(database);
      const store = createWorkerLeaseStore(database);
      leaseHeld = store.acquire(options.identity, Date.now(), options.leaseTtlMs) === "held";
      return store;
    } catch (error) {
      try {
        database.close();
      } catch {
        // Preserve the original migration or acquisition error.
      }
      throw error;
    }
  })();
  if (leaseHeld) {
    try {
      postEnvelope(options.port.postMessage.bind(options.port), handshakeEnvelope("worker.rejected", options.identity));
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
    const git = new GitCommandRunner();
    const gitReadService = new GitReadService(git);
    const managedWorktreeRootPath = resolve(dirname(options.dbPath), "managed-worktrees");
    await mkdir(managedWorktreeRootPath, { recursive: true });
    const managedWorktreeRoot = await realpath(managedWorktreeRootPath);
    const taskService = new TaskService({
      repositories,
      eventStore,
      idempotencyStore,
      gitReadService,
      managedWorktreeRoot,
      workerGeneration: options.identity.workerGeneration,
      id: ids.next,
      now: clock.now
    });
    const artifacts = new GitArtifactRepository(database);
    const operations = new JournaledOperationRunner(repositories.operations);
    const manager = new GitManager({
      git,
      readService: gitReadService,
      artifacts,
      projects: repositories.projects,
      tasks: repositories.tasks,
      lock: new RepositoryLock(),
      operations,
      journal: repositories.operations,
      managedWorktreeRoot,
      id: ids.next,
      now: clock.now
    });
    const publishRoomEvent = (
      event: z.infer<typeof RoomEventSchema>,
      requestId: string = randomUUID()
    ): void => {
      postEnvelope(options.port.postMessage.bind(options.port), WorkerEventEnvelopeSchema.parse({
        v: PROTOCOL_VERSION,
        requestId,
        idempotencyKey: event.id,
        workerGeneration: options.identity.workerGeneration,
        type: "room.event",
        payload: event
      }));
    };
    const invalidateState = (): void => {
      postEnvelope(options.port.postMessage.bind(options.port), WorkerEventEnvelopeSchema.parse({
        v: PROTOCOL_VERSION,
        requestId: randomUUID(),
        idempotencyKey: `state-invalidated:${randomUUID()}`,
        workerGeneration: options.identity.workerGeneration,
        type: "state.invalidated",
        payload: { roomId: null }
      }));
    };
    const provider = options.e2eMock
      ? new MockProvider((request) => e2eMockScript(options.e2eMock!.scenario, request))
      : createDefaultTaskProvider();
    const taskExecutionServices = createTaskExecutionServices({
      repositories,
      artifacts,
      events: eventStore,
      manager,
      provider,
      operations,
      workerGeneration: options.identity.workerGeneration,
      contextVersion: 1,
      contextHash: hashCanonical({
        source: "worker-runtime",
        workerGeneration: options.identity.workerGeneration
      }),
      id: ids.next,
      now: clock.now,
      publish: publishRoomEvent
    });
    const finalApproval = new FinalApprovalService({
      tasks: repositories.tasks,
      approvals: repositories.approvals,
      events: eventStore,
      tupleSource: new GitCandidateTupleSource({
        tasks: repositories.tasks,
        artifacts,
        projects: repositories.projects,
        manager,
        git
      }),
      candidates: { get: (candidateId) => artifacts.getCandidate(candidateId) },
      workerGeneration: options.identity.workerGeneration,
      id: ids.next,
      now: clock.now
    });
    const processes = new JournaledProcessRunner({
      journal: repositories.operations,
      id: ids.next,
      now: clock.now
    });
    const commands = new ApprovedCommandRunner({
      catalog: {
        get(projectId, commandId) {
          if (!options.e2eMock || commandId !== "unit") return null;
          const task = repositories.tasks.listNonTerminal().find((candidate) => candidate.projectId === projectId);
          if (!task) return null;
          const lead = artifacts.getWorktree(task.id, "lead");
          if (!lead) return null;
          return {
            commandId: "unit",
            displayName: "E2E unit test",
            commandClass: "test",
            executableRealpath: "/usr/bin/true",
            argv: [],
            cwdRealpath: lead.pathRealpath,
            timeoutMs: 5_000,
            network: "none"
          };
        }
      },
      processes,
      id: ids.next,
      now: clock.now
    });
    const candidates = new CandidateService({
      tasks: repositories.tasks,
      approvals: repositories.approvals,
      artifacts,
      projects: repositories.projects,
      manager,
      git,
      commands,
      events: eventStore,
      id: ids.next,
      now: clock.now
    });
    const recovery = new RecoveryCoordinator({
      tasks: repositories.tasks,
      approvals: repositories.approvals,
      operations: repositories.operations,
      artifacts,
      projects: repositories.projects,
      reconciler: new GitOperationReconciler({ projects: repositories.projects, git }),
      events: eventStore,
      workerGeneration: options.identity.workerGeneration,
      id: ids.next,
      now: clock.now
    });
    await recovery.markInterruptedAfterGenerationChange("", options.identity.workerGeneration);
    const inspector = new TaskInspectorQuery({
      tasks: repositories.tasks,
      approvals: repositories.approvals,
      artifacts,
      recovery
    });
    setTaskSnapshotSource(eventStore, inspector);
    const merge = new MergeService({
      finalApproval,
      tasks: repositories.tasks,
      projects: repositories.projects,
      manager,
      readService: gitReadService,
      events: eventStore,
      id: ids.next,
      now: clock.now
    });
    const taskWorkflow = options.e2eMock
      ? new E2EMockWorkflow({
          scenario: options.e2eMock.scenario,
          engine: taskExecutionServices.engine,
          collaboration: taskExecutionServices.collaboration,
          candidates,
          finalApproval,
          tasks: repositories.tasks,
          artifacts,
          manager,
          workerGeneration: options.identity.workerGeneration,
          id: ids.next,
          invalidate: invalidateState
        })
      : undefined;
    const taskCommandHandlers = createTaskCommandHandlers({
      workerGeneration: options.identity.workerGeneration,
      taskService,
      taskEngine: taskExecutionServices.engine,
      finalApproval,
      merge,
      recovery,
      inspector,
      ...(taskWorkflow ? { taskWorkflow } : {})
    });
    const router = createWorkerRouter({
      workerGeneration: options.identity.workerGeneration,
      handlers: createCommandHandlers({
        projectService,
        roomService,
        taskService,
        taskExecutionServices,
        taskCommandHandlers,
        prepareQuit: runtime.prepareQuit
      })
    });
    const onMessage = (value: unknown): void => {
      void (async () => {
        if (lifecycle === "stopped") return;
        let request: z.infer<typeof WorkerRequestEnvelopeSchema>;
        try {
          assertEnvelopeSize(value);
          request = WorkerRequestEnvelopeSchema.parse(value);
        } catch {
          const response = invalidRequestResponse(value, options.identity.workerGeneration);
          if (response === undefined) {
            stopQuietly();
            return;
          }
          try {
            postEnvelope(options.port.postMessage.bind(options.port), response);
          } catch {
            stopQuietly();
          }
          return;
        }

        try {
          const response = WorkerResponseEnvelopeSchema.parse(await router(request));
          postEnvelope(options.port.postMessage.bind(options.port), response);
          if (response.payload.ok && response.payload.requestType === "message.post" && !response.payload.replayed) {
            const event = RoomEventSchema.parse(response.payload.data);
            publishRoomEvent(event, request.requestId);
            const created = eventStore.after({ roomId: event.roomId, roomSeq: event.roomSeq, limit: 50 });
            for (const later of created.events) publishRoomEvent(later);
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
    postEnvelope(options.port.postMessage.bind(options.port), handshakeEnvelope("worker.ready", options.identity));
    if (lifecycle === "starting") lifecycle = "active";
    return runtime;
  } catch (error) {
    stopQuietly();
    throw error;
  }
}
