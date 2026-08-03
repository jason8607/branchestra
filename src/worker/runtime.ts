import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { homedir, tmpdir, userInfo } from "node:os";
import { mkdir, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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
import { GitOperationReconciler, reconcileAppliedArchiveOperations } from "./git/git-operation-reconciler";
import { MergeService } from "./git/merge-service";
import { GitReadService } from "./git/repository-inspector";
import { JournaledOperationRunner } from "./operations/journaled-operation-runner";
import { JournaledProcessRunner } from "./operations/journaled-process-runner";
import { RepositoryLock } from "./operations/repository-lock";
import { ProviderHealthService } from "./providers/provider-health-service";
import { RunnerBackedAdapter } from "./providers/runner-backed-adapter";
import { createProviderRegistry } from "./providers/provider-registry";
import { RegistryTaskProvider } from "./providers/registry-task-provider";
import { SupervisedProviderRunner } from "./process/supervised-provider-runner";
import { normalizeClaudeEvent } from "./providers/normalization/claude-event";
import { normalizeCodexEvent } from "./providers/normalization/codex-event";
import { buildProviderEnvironment } from "./providers/provider-environment";
import { execFileNoShell } from "./process/exec-file";
import { ProcessIdentityProbe } from "./process/process-identity";
import { ProviderProcessSupervisor } from "./process/provider-process-supervisor";
import { CURRENT_PRIVATE_CODEX_CLI_VERSION, validateCodexSubscriptionConfigLock } from "../shared/security/codex-config-lock";
import { EFFECTIVE_PROVIDER_POLICY } from "../shared/config/effective-provider-policy";
import { CLAUDE_CAPABILITIES } from "../provider-runner/claude-runtime";
import { CODEX_CAPABILITIES } from "../provider-runner/codex-runtime";
import { ReadOnlyToolService } from "./tools/read-only-tool-service";
import { ToolBridge } from "./tools/tool-bridge";
import { ContextBuilder } from "./context/context-builder";
import { ContextRepository } from "./context/context-repository";
import { RuntimeContextSource } from "./context/runtime-context-source";
import { createTaskRunContextPreparer } from "./context/task-run-context";
import { exportDiagnosticBundle } from "./diagnostics/export-bundle";
import { CleanupRepository } from "./cleanup/cleanup-repository";
import { CleanupCommandService } from "./cleanup/cleanup-command-service";
import { CleanupService } from "./cleanup/cleanup-service";
import { RotatingLog } from "./diagnostics/rotating-log";
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
  const diagnosticLog = new RotatingLog(resolve(dirname(options.dbPath), "logs", "worker.jsonl"));
  const recentErrors: Array<{ at: string; scope: string; name: string; code: string }> = [];
  const recordError = (scope: string, error: unknown): void => {
    const candidateCode = error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "UNCLASSIFIED";
    const record = {
      at: new Date().toISOString(),
      scope,
      name: error instanceof Error ? error.name : "UnknownError",
      code: /^[A-Z0-9_]{1,80}$/.test(candidateCode) ? candidateCode : "UNCLASSIFIED"
    };
    recentErrors.push(record);
    if (recentErrors.length > 50) recentErrors.shift();
    void diagnosticLog.write(record).catch(() => undefined);
  };
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
    const architecture = process.arch;
    if (architecture !== "arm64" && architecture !== "x64") throw new Error(`Unsupported Provider architecture: ${architecture}`);
    const packagedResources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const resourcesRootRealpath = packagedResources ?? process.cwd();
    const providerHealthService = new ProviderHealthService({
      repository: repositories.providers,
      runner: execFileNoShell,
      host: {
        homeDirectory: homedir(), temporaryDirectory: tmpdir(), userName: userInfo().username,
        architecture, resourcesRootRealpath,
      },
      validateCodexSubscriptionConfigLock: (input) => validateCodexSubscriptionConfigLock({
        ...input,
        manifestPath: resolve(resourcesRootRealpath, packagedResources ? "codex-config-lock-manifest.json" : "config/codex-config-lock-manifest.json"),
      }),
      now: () => new Date().toISOString(),
    });
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
    const gitOperationReconciler = new GitOperationReconciler({
      projects: repositories.projects,
      git,
      artifacts
    });
    await reconcileAppliedArchiveOperations({
      operations: repositories.operations,
      reconciler: gitOperationReconciler
    });
    const prepareContext = createTaskRunContextPreparer({
      builder: new ContextBuilder(new RuntimeContextSource(database, artifacts)),
      repository: new ContextRepository(repositories.providers, clock.now),
      approvedScope(task) {
        if (!task.scopeApprovalId) throw new Error("TASK_SCOPE_APPROVAL_REQUIRED");
        return repositories.approvals.getRequired(task.scopeApprovalId).scope;
      }
    });
    const operations = new JournaledOperationRunner(repositories.operations);
    const repositoryLock = new RepositoryLock();
    const manager = new GitManager({
      git,
      readService: gitReadService,
      artifacts,
      projects: repositories.projects,
      tasks: repositories.tasks,
      lock: repositoryLock,
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
    const provider = (() => {
      if (options.e2eMock) return new MockProvider((request) => e2eMockScript(options.e2eMock!.scenario, request));
      const processSupervisor = new ProviderProcessSupervisor({
        probe: new ProcessIdentityProbe(execFileNoShell),
        journal: repositories.operations,
        now: clock.now,
      });
      const runner = new SupervisedProviderRunner({
        supervisor: processSupervisor,
        runnerEntryRealpath: resolve(dirname(fileURLToPath(import.meta.url)), "provider-runner.js"),
        workerGeneration: options.identity.workerGeneration,
        recordIntent(input) {
          const task = repositories.tasks.getRequired(input.taskId);
          const project = repositories.projects.findById(task.projectId);
          if (!project) throw new Error(`PROJECT_NOT_FOUND:${task.projectId}`);
          const at = clock.now();
          repositories.operations.recordIntent({
            id: ids.next(),
            projectId: project.id,
            taskId: task.id,
            repositoryCommonDirRealpath: project.gitCommonDir,
            operationType: "provider_process",
            idempotencyKey: `provider-process:${input.runId}`,
            expected: input,
            status: "intent",
            observation: null,
            workerGeneration: options.identity.workerGeneration,
            createdAt: at,
            updatedAt: at,
          });
        },
      });
      const lockRealpath = async (): Promise<string> => {
        const decision = await validateCodexSubscriptionConfigLock({
          resourcesRootRealpath,
          expectedCliVersion: CURRENT_PRIVATE_CODEX_CLI_VERSION,
          manifestPath: resolve(resourcesRootRealpath, packagedResources ? "codex-config-lock-manifest.json" : "config/codex-config-lock-manifest.json"),
        });
        if (!decision.valid) throw new Error(decision.reason);
        return decision.realpath;
      };
      const readOnlyTools = new ReadOnlyToolService({
        git: gitReadService,
        context: {
          async search(input) {
            return database.prepare(`SELECT id AS eventId, room_seq AS roomSeq, payload_json AS payload
              FROM room_events WHERE room_id = ? AND event_type = 'message.posted' AND payload_json LIKE ?
              ORDER BY room_seq DESC LIMIT ?`).all(input.roomId, `%${input.query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`, input.limit);
          },
          async read(input) {
            if (input.eventIds.length === 0) return [];
            const placeholders = input.eventIds.map(() => "?").join(",");
            return database.prepare(`SELECT id AS eventId, room_seq AS roomSeq, payload_json AS payload
              FROM room_events WHERE room_id = ? AND id IN (${placeholders}) ORDER BY room_seq LIMIT ?`)
              .all(input.roomId, ...input.eventIds, input.limit);
          },
        },
      });
      const adapter = (providerId: "claude" | "codex") => new RunnerBackedAdapter({
        provider: providerId,
        capabilities: providerId === "claude" ? CLAUDE_CAPABILITIES : CODEX_CAPABILITIES,
        health: providerHealthService,
        codexConfigLockRealpath: lockRealpath,
        runner,
        normalize: providerId === "claude" ? normalizeClaudeEvent : normalizeCodexEvent,
        now: clock.now,
        repository: repositories.providers,
        async handleToolCall(input) {
          const task = repositories.tasks.getRequired(input.taskRequest.taskId);
          const project = repositories.projects.findById(task.projectId);
          if (!project) throw new Error(`PROJECT_NOT_FOUND:${task.projectId}`);
          const bridge = new ToolBridge(readOnlyTools, () => ({
            roomId: task.roomId,
            taskId: task.id,
            repositoryRootRealpath: project.repositoryRoot,
            worktreePathRealpath: input.taskRequest.worktreePath,
            startOid: task.baseOid,
            checkpointOids: new Set(artifacts.listCheckpoints(task.id).map((checkpoint) => checkpoint.oid)),
          }));
          const result = await bridge.handle(input);
          return { content: result.content, truncated: result.truncated };
        },
        environmentFor(health) {
          if (!health.executableRealpath) throw new Error(`PROVIDER_EXECUTABLE_MISSING:${providerId}`);
          return buildProviderEnvironment({
            provider: providerId,
            executableRealpath: health.executableRealpath,
            homeDirectory: homedir(),
            temporaryDirectory: tmpdir(),
            userName: userInfo().username,
            approvedPathEntries: [],
            source: process.env,
          });
        },
      });
      return new RegistryTaskProvider(createProviderRegistry({
        policy: {
          claudeSubscription: { enabled: EFFECTIVE_PROVIDER_POLICY.claudeSubscription.enabled },
          codexSubscription: { enabled: EFFECTIVE_PROVIDER_POLICY.codexSubscription.enabled },
        },
        createClaudeAdapter: () => adapter("claude"),
        createCodexAdapter: () => adapter("codex"),
      }));
    })();
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
      prepareContext,
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
      reconciler: gitOperationReconciler,
      events: eventStore,
      workerGeneration: options.identity.workerGeneration,
      async renewFinalApproval(taskId, idempotencyKey) {
        await finalApproval.request(taskId, idempotencyKey);
      },
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
          workerGeneration: options.identity.workerGeneration,
          invalidate: invalidateState
        })
      : undefined;
    const cleanupCommands = new CleanupCommandService({
      database,
      repository: new CleanupRepository(database, clock.now),
      idempotency: idempotencyStore
    });
    const cleanupService = new CleanupService({
      database,
      git,
      lock: repositoryLock,
      operations,
      recoveryRoot: resolve(dirname(options.dbPath), "recovery", "worktrees"),
      workerGeneration: options.identity.workerGeneration,
      id: ids.next,
      now: clock.now
    });
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
        providerHealthService,
        async exportDiagnostics(destinationPath) {
          const counts = database.prepare(
            "SELECT state, COUNT(*) AS count FROM tasks GROUP BY state ORDER BY state"
          ).all() as unknown as Array<{ state: string; count: number }>;
          return exportDiagnosticBundle({
            appVersion: "0.1.0",
            platform: {
              os: process.platform,
              arch: process.arch,
              electron: process.versions.electron ?? "unknown",
              node: process.versions.node
            },
            providerHealth: await providerHealthService.list(),
            taskStateCounts: Object.fromEntries(counts.map(({ state, count }) => [state, Number(count)])),
            recentErrors: [...recentErrors]
          }, destinationPath);
        },
        previewRoomCleanup: (roomId) => cleanupCommands.previewRoom(roomId),
        removeRoomCleanup(receipt, command) {
          const result = cleanupCommands.removeRoom(receipt, command);
          if (!result.replayed) invalidateState();
          return result;
        },
        previewWorktreeCleanup: (worktreeId) => cleanupService.previewWorktree(worktreeId),
        archiveWorktreeCleanup: (receipt, idempotencyKey) => cleanupService.archiveWorktree(receipt, idempotencyKey),
        previewProjectCleanup: (projectId) => cleanupCommands.previewProject(projectId),
        removeProjectCleanup(receipt, command) {
          const result = cleanupCommands.removeProject(receipt, command);
          if (!result.replayed) invalidateState();
          return result;
        },
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
        } catch (error) {
          recordError("worker.request", error);
          stopQuietly();
        }
      })().catch((error: unknown) => {
        recordError("worker.request.unhandled", error);
        stopQuietly();
      });
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
      } catch (error) {
        recordError("worker.heartbeat", error);
        stopQuietly();
      }
    }, options.heartbeatIntervalMs);
    if (isStopped()) return runtime;
    postEnvelope(options.port.postMessage.bind(options.port), handshakeEnvelope("worker.ready", options.identity));
    if (lifecycle === "starting") lifecycle = "active";
    return runtime;
  } catch (error) {
    recordError("worker.startup", error);
    stopQuietly();
    throw error;
  }
}
