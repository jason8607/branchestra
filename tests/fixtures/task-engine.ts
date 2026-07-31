import { randomUUID } from "node:crypto";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ApprovalReceipt,
  ApprovalRequest,
  Project,
  Room,
  RoomEvent,
  TaskRecord
} from "../../src/shared/contracts/domain";
import { hashCanonical } from "../../src/worker/approvals/canonical-json";
import { ApprovedCommandRunner } from "../../src/worker/approvals/approved-command-runner";
import {
  FinalApprovalService,
  GitCandidateTupleSource
} from "../../src/worker/approvals/final-approval-service";
import { CollaborationCoordinator } from "../../src/worker/tasks/collaboration-coordinator";
import { GitArtifactRepository } from "../../src/worker/git/git-artifact-repository";
import { GitCommandRunner } from "../../src/worker/git/git-command-runner";
import { GitManager } from "../../src/worker/git/git-manager";
import { IntegrationService } from "../../src/worker/git/integration-service";
import { MergeService } from "../../src/worker/git/merge-service";
import { GitReadService } from "../../src/worker/git/repository-inspector";
import { JournaledOperationRunner } from "../../src/worker/operations/journaled-operation-runner";
import { JournaledProcessRunner } from "../../src/worker/operations/journaled-process-runner";
import { RepositoryLock } from "../../src/worker/operations/repository-lock";
import {
  MockProvider,
  type MockProviderStep
} from "../../src/worker/providers/mock-provider";
import type {
  TaskProviderPort,
  TaskProviderRunRequest
} from "../../src/worker/tasks/provider-port";
import { TaskEngine } from "../../src/worker/tasks/task-engine";
import type { TaskEngineOptions } from "../../src/worker/tasks/task-engine";
import { CandidateService } from "../../src/worker/tasks/candidate-service";
import { TaskService } from "../../src/worker/tasks/task-service";
import { transitionTask } from "../../src/worker/tasks/task-state-machine";
import { createEventStore } from "../../src/worker/storage/event-store";
import { createIdempotencyStore } from "../../src/worker/storage/idempotency-store";
import { createRepositories } from "../../src/worker/storage/repositories";
import { createGitRepositoryFixture } from "./git-repository";
import { openTestDatabase } from "./test-database";

export interface ApprovedTaskFixtureOptions {
  generation?: string;
  id?: () => string;
}

export async function createApprovedTaskFixture(
  options: ApprovedTaskFixtureOptions = {}
) {
  const repository = await createGitRepositoryFixture();
  const managedWorktreeRoot = await realpath(
    await mkdtemp(join(tmpdir(), "branchestra-managed-worktrees-"))
  );
  const databaseFixture = openTestDatabase();
  const repositories = createRepositories(databaseFixture.db);
  const eventStore = createEventStore(databaseFixture.db, repositories);
  const generation = options.generation ?? "50000000-0000-4000-8000-000000000001";
  const createdAt = "2026-07-24T10:00:00.000Z";
  const project: Project = {
    id: "10000000-0000-4000-8000-000000000099",
    repositoryRoot: await realpath(repository.root),
    gitCommonDir: repository.commonDirRealpath,
    displayName: "task-engine-fixture",
    headOid: repository.initialOid,
    defaultBranch: "main",
    createdAt
  };
  const room: Room = {
    id: "20000000-0000-4000-8000-000000000099",
    projectId: project.id,
    title: "Task fixture",
    createdAt
  };
  repositories.projects.insert(project);
  repositories.rooms.insert(room);
  let tick = 0;
  const now = () => `2026-07-24T10:00:${String(tick++).padStart(2, "0")}.000Z`;
  const service = new TaskService({
    repositories,
    eventStore,
    idempotencyStore: createIdempotencyStore(databaseFixture.db, now),
    gitReadService: new GitReadService(new GitCommandRunner()),
    managedWorktreeRoot,
    workerGeneration: generation,
    id: options.id ?? randomUUID,
    now
  });
  const allEvents = (): RoomEvent[] => {
    const events: RoomEvent[] = [];
    let roomSeq = 0;
    while (true) {
      const page = eventStore.after({
        roomId: room.id,
        roomSeq,
        limit: 500
      });
      events.push(...page.events);
      if (!page.hasMore) return events;
      if (page.nextRoomSeq === roomSeq) throw new Error("EVENT_FIXTURE_CURSOR_STALLED");
      roomSeq = page.nextRoomSeq;
    }
  };

  return {
    service,
    repositories,
    eventStore,
    databaseFixture,
    now,
    tasks: repositories.tasks,
    approvals: repositories.approvals,
    events: {
      all: allEvents,
      byType<TType extends RoomEvent["type"]>(type: TType) {
        return allEvents().filter(
          (event): event is Extract<RoomEvent, { type: TType }> => event.type === type
        );
      }
    },
    repository,
    project,
    room,
    generation,
    managedWorktreeRoot,
    async captureGitState() {
      const [status, head, refs, worktrees] = await Promise.all([
        repository.run(["status", "--porcelain=v2", "--untracked-files=all"]),
        repository.run(["rev-parse", "--verify", "HEAD^{commit}"]),
        repository.run(["show-ref", "--head"]),
        repository.run(["worktree", "list", "--porcelain"])
      ]);
      return {
        status: status.stdout,
        head: head.stdout,
        refs: refs.stdout,
        worktrees: worktrees.stdout
      };
    },
    async cleanup() {
      databaseFixture.db.close();
      await Promise.all([
        repository.cleanup(),
        rm(managedWorktreeRoot, { recursive: true, force: true }),
        rm(databaseFixture.directory, { recursive: true, force: true })
      ]);
    }
  };
}

export interface TaskEngineFixtureOptions {
  mockScript: MockProviderStep[];
  initialState?: import("../../src/shared/contracts/domain").TaskState;
  commandClasses?: Array<"build" | "test" | "lint" | "format">;
  allowCollaborator?: boolean;
  maxRunMs?: number;
  providerOverride?: TaskProviderPort;
  prepareContext?: NonNullable<TaskEngineOptions["prepareContext"]>;
  publishOverride?: (event: RoomEvent) => void | Promise<void>;
}

export async function createTaskEngineFixture(options: TaskEngineFixtureOptions) {
  let nextIdNumber = 0;
  const id = () => nextIdNumber++ === 0 ? "task-1" : randomUUID();
  const base = await createApprovedTaskFixture({ id });
  const created = await base.service.createFromUserMessage({
    roomId: base.room.id,
    messageEventId: "message-task-1",
    text: "@Claude implement fixture task",
    explicitLead: "claude",
    idempotencyKey: "create-task-1",
    commandClasses: options.commandClasses ?? ["build", "test", "lint", "format"],
    allowCollaborator: options.allowCollaborator ?? true,
    maxRunMs: options.maxRunMs ?? 2_000
  });
  await base.service.decideScope({
    taskId: created.task.id,
    approvalRequestId: created.approvalRequest.id,
    decision: "approved",
    displayedScopeHash: created.approvalRequest.scopeHash,
    workerGeneration: base.generation,
    idempotencyKey: "approve-task-1"
  });
  if (options.initialState && options.initialState !== "Preparing") {
    const current = base.repositories.tasks.getRequired("task-1");
    base.repositories.tasks.updateState({
      ...current,
      state: options.initialState,
      version: current.version + 1,
      updatedAt: base.now()
    }, current.version);
  }

  const artifacts = new GitArtifactRepository(base.databaseFixture.db);
  const journalRunner = new JournaledOperationRunner(base.repositories.operations);
  const gitArgvHistory: Array<readonly string[]> = [];
  const realGit = new GitCommandRunner();
  let failAfterNextCherryPick = false;
  const trackedGit = {
    async run(cwd: string, argv: readonly string[]) {
      gitArgvHistory.push([...argv]);
      const result = await realGit.run(cwd, argv);
      if (failAfterNextCherryPick && argv[0] === "cherry-pick") {
        failAfterNextCherryPick = false;
        throw new Error("INJECTED_POST_CHERRY_PICK_FAILURE");
      }
      return result;
    },
    async runBuffer(cwd: string, argv: readonly string[]) {
      gitArgvHistory.push([...argv]);
      return realGit.runBuffer(cwd, argv);
    }
  };
  const manager = new GitManager({
    git: trackedGit,
    readService: new GitReadService(trackedGit),
    artifacts,
    projects: base.repositories.projects,
    tasks: base.repositories.tasks,
    lock: new RepositoryLock(),
    operations: journalRunner,
    journal: base.repositories.operations,
    managedWorktreeRoot: base.managedWorktreeRoot,
    id,
    now: base.now
  });
  const mock = new MockProvider(() => ({
    sessionId: "mock-session-1",
    steps: options.mockScript
  }));
  const calls = { startRun: 0, resumeRun: 0, cancelRun: 0 };
  const providerRequests: TaskProviderRunRequest[] = [];
  const providerTarget = options.providerOverride ?? mock;
  const provider: TaskProviderPort = {
    async startRun(request) {
      calls.startRun += 1;
      providerRequests.push(request);
      return providerTarget.startRun(request);
    },
    async resumeRun(request) {
      calls.resumeRun += 1;
      providerRequests.push(request);
      return providerTarget.resumeRun(request);
    },
    async cancelRun(runId, reason) {
      calls.cancelRun += 1;
      return providerTarget.cancelRun(runId, reason);
    }
  };
  const publishOrdering: boolean[] = [];
  const engine = new TaskEngine({
    repositories: base.repositories,
    artifacts,
    events: base.eventStore,
    manager,
    provider,
    operations: journalRunner,
    workerGeneration: base.generation,
    contextVersion: 1,
    contextHash: `sha256:${"1".repeat(64)}`,
    ...(options.prepareContext ? { prepareContext: options.prepareContext } : {}),
    id,
    now: base.now,
    async publish(event) {
      publishOrdering.push(base.events.all().some(({ id: eventId }) => eventId === event.id));
      await options.publishOverride?.(event);
    }
  });
  const lead = () => artifacts.getWorktree("task-1", "lead");

  return {
    engine,
    mock,
    provider,
    repositories: base.repositories,
    databaseFixture: base.databaseFixture,
    eventStore: base.eventStore,
    tasks: base.repositories.tasks,
    events: {
      ...base.events,
      types: () => base.events.all().map(({ type }) => type),
      persistedBeforePublish: () => publishOrdering.every(Boolean)
    },
    artifacts,
    journal: base.repositories.operations,
    repository: base.repository,
    project: base.project,
    room: base.room,
    manager,
    generation: base.generation,
    id,
    now: base.now,
    inMemoryRunCounts() {
      const internals = engine as unknown as {
        activeRuns: Map<string, unknown>;
        pendingRuns: Map<string, unknown>;
      };
      return {
        active: internals.activeRuns.size,
        pending: internals.pendingRuns.size
      };
    },
    providerCalls: () => ({ ...calls }),
    providerRequests: () => [...providerRequests],
    gitMutationCalls: () => gitArgvHistory.map((argv) => argv.join(" ")),
    gitCommandCalls: () => gitArgvHistory.map((argv) => [...argv]),
    failAfterNextCherryPick() {
      failAfterNextCherryPick = true;
    },
    appendNoiseEvents(count: number) {
      const createdAt = base.project.createdAt;
      for (let index = 0; index < count; index += 1) {
        base.eventStore.append({
          id: randomUUID(),
          roomId: base.room.id,
          type: "message.posted",
          actor: "user",
          payload: {
            id: randomUUID(),
            roomId: base.room.id,
            body: `noise-${index}`,
            createdAt
          },
          createdAt
        });
      }
    },
    captureGitState: base.captureGitState,
    async prepareLead(key: string) {
      return manager.ensureAgentWorktree({
        projectId: base.project.id,
        taskId: "task-1",
        role: "lead",
        baseOid: base.repository.initialOid,
        repositoryRootRealpath: base.project.repositoryRoot,
        commonDirRealpath: base.project.gitCommonDir,
        workerGeneration: base.generation,
        idempotencyKey: key
      });
    },
    async readLeadFile(relativePath: string) {
      const worktree = lead();
      if (!worktree) throw new Error("LEAD_WORKTREE_NOT_FOUND");
      return base.repository.readAt(worktree.pathRealpath, relativePath);
    },
    async leadBranchExists() {
      const worktree = lead();
      if (!worktree) return false;
      try {
        await base.repository.run(["rev-parse", "--verify", worktree.branchRef]);
        return true;
      } catch {
        return false;
      }
    },
    async leadPathExists(relativePath: string) {
      const worktree = lead();
      if (!worktree) return false;
      try {
        await access(join(worktree.pathRealpath, relativePath));
        return true;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
      }
    },
    async absolutePathExists(path: string) {
      try {
        await access(path);
        return true;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
      }
    },
    async createLeadSymlink(relativePath: string, target: string) {
      const worktree = lead();
      if (!worktree) throw new Error("LEAD_WORKTREE_NOT_FOUND");
      const { symlink } = await import("node:fs/promises");
      await symlink(target, join(worktree.pathRealpath, relativePath), "dir");
    },
    cleanup: base.cleanup
  };
}

export interface CollaborationFixtureOptions {
  state?: TaskRecord["state"];
  roundsUsed?: number;
  allowCollaborator?: boolean;
  reviewerWrites?: boolean;
  reviewerWaitsForCancel?: boolean;
  parallelImplementation?: boolean;
  maxRunMs?: number;
}

export async function createCollaborationFixture(
  options: CollaborationFixtureOptions = {}
) {
  const requests: TaskProviderRunRequest[] = [];
  const scripted = new MockProvider((request) => ({
    sessionId: `mock-${request.role}-${requests.length}`,
    steps: request.role === "lead"
      ? [
          { type: "workspace.writeText", relativePath: "lead.txt", contents: "initial\n" },
          { type: "run.completed", summary: "Lead checkpoint ready" }
        ]
      : request.role === "reviewer"
        ? [
            ...(options.reviewerWrites
              ? [{ type: "workspace.writeText" as const, relativePath: "forbidden.txt", contents: "no\n" }]
              : []),
            ...(options.reviewerWaitsForCancel
              ? [{ type: "waitForCancel" as const }]
              : []),
            { type: "run.completed", summary: "Review completed" }
          ]
        : [
            ...(options.parallelImplementation
              ? [{
                  type: "workspace.writeText" as const,
                  relativePath: "alternative.txt",
                  contents: "alternative\n"
                }]
              : []),
            { type: "run.completed", summary: "Collaborator completed" }
          ]
  }));
  const provider: TaskProviderPort = {
    startRun(request) {
      requests.push(request);
      return scripted.startRun(request);
    },
    resumeRun(request) {
      return scripted.resumeRun(request);
    },
    cancelRun(runId, reason) {
      return scripted.cancelRun(runId, reason);
    }
  };
  const base = await createTaskEngineFixture({
    mockScript: [],
    ...(options.allowCollaborator === undefined
      ? {}
      : { allowCollaborator: options.allowCollaborator }),
    ...(options.maxRunMs === undefined ? {} : { maxRunMs: options.maxRunMs }),
    providerOverride: provider
  });
  const desiredState = options.state;
  if (desiredState !== undefined || options.roundsUsed !== undefined) {
    const current = base.tasks.getRequired("task-1");
    base.tasks.updateState({
      ...current,
      state: desiredState ?? current.state,
      collaborationRoundsUsed: options.roundsUsed ?? current.collaborationRoundsUsed,
      version: current.version + 1,
      updatedAt: base.now()
    }, current.version);
  }

  const collaboration = new CollaborationCoordinator({
    repositories: base.repositories,
    artifacts: base.artifacts,
    events: base.eventStore,
    manager: base.manager,
    engine: base.engine,
    workerGeneration: base.generation,
    contextVersion: 1,
    contextHash: `sha256:${"1".repeat(64)}`,
    id: base.id,
    now: base.now
  });

  const ensureLeadCheckpoint = async () => {
    const existing = base.artifacts.listCheckpoints("task-1")
      .filter((checkpoint) => checkpoint.worktreeId
        === base.artifacts.getWorktree("task-1", "lead")?.id)
      .at(-1);
    if (existing) return existing;
    const lead = await base.prepareLead("prepare-existing-lead");
    await base.repository.writeAt(lead.pathRealpath, "lead.txt", "existing\n");
    return base.manager.createCheckpoint({
      projectId: base.project.id,
      taskId: "task-1",
      worktree: lead,
      authorProvider: "claude",
      purpose: "implementation",
      message: "Existing lead checkpoint",
      checkpointId: "lead-existing",
      workerGeneration: base.generation,
      idempotencyKey: "lead-existing"
    });
  };
  if (desiredState !== undefined && desiredState !== "Preparing") {
    await ensureLeadCheckpoint();
  }

  const latestCheckpoint = (role: "lead" | "collaborator") => {
    const worktree = base.artifacts.getWorktree("task-1", role);
    if (!worktree) throw new Error(`${role.toUpperCase()}_WORKTREE_NOT_FOUND`);
    const checkpoint = base.artifacts.listCheckpoints("task-1")
      .filter((candidate) => candidate.worktreeId === worktree.id)
      .at(-1);
    if (!checkpoint) throw new Error(`${role.toUpperCase()}_CHECKPOINT_NOT_FOUND`);
    return checkpoint;
  };

  return {
    ...base,
    collaboration,
    mock: {
      requests: () => [...requests],
      waitUntilBlocked: () => scripted.waitUntilBlocked(),
      async cancelLastRun(reason: "user" | "quit" | "timeout" = "user") {
        const request = requests.at(-1);
        if (request) await scripted.cancelRun(request.runId, reason);
      },
      lastRequest(providerName: "claude" | "codex") {
        const request = [...requests].reverse().find(({ provider }) => provider === providerName);
        if (!request) throw new Error(`MOCK_REQUEST_NOT_FOUND:${providerName}`);
        return request;
      }
    },
    latestCheckpoint,
    async runLeadRevision() {
      const lead = base.artifacts.getWorktree("task-1", "lead");
      if (!lead) throw new Error("LEAD_WORKTREE_NOT_FOUND");
      await base.repository.writeAt(lead.pathRealpath, "lead.txt", "revised\n");
      return base.manager.createCheckpoint({
        projectId: base.project.id,
        taskId: "task-1",
        worktree: lead,
        authorProvider: "claude",
        purpose: "revision",
        message: "Lead revision",
        checkpointId: `lead-revision-${base.artifacts.listCheckpoints("task-1").length}`,
        workerGeneration: base.generation,
        idempotencyKey: `lead-revision-${base.artifacts.listCheckpoints("task-1").length}`
      });
    },
    requestHumanRevision(instruction: string) {
      const current = base.tasks.getRequired("task-1");
      return base.tasks.applyTransition(
        transitionTask(
          { ...current, updatedAt: base.now() },
          { type: "requestHumanRevision", instruction }
        ),
        base.id()
      );
    },
    grantAdditionalRound(additionalRounds: 1 | 2) {
      const task = base.tasks.getRequired("task-1");
      const requestedAt = base.now();
      const scope = { additionalRounds };
      const request: ApprovalRequest = {
        id: base.id(),
        taskId: task.id,
        kind: "additional_round",
        scope,
        scopeHash: hashCanonical(scope),
        requestedGeneration: base.generation,
        status: "pending",
        requestedAt
      };
      const receipt: ApprovalReceipt = {
        id: base.id(),
        requestId: request.id,
        taskId: task.id,
        kind: "additional_round",
        scope,
        decision: "approved",
        scopeHash: request.scopeHash,
        workerGeneration: base.generation,
        survivesWorkerRestart: false,
        decidedAt: base.now()
      };
      base.repositories.approvals.insertRequest(request);
      base.repositories.approvals.decideRequest(request.id, receipt);
      base.eventStore.append({
        id: base.id(),
        roomId: task.roomId,
        type: "approval.decided",
        actor: "system",
        payload: { receipt },
        createdAt: receipt.decidedAt
      });
      return base.tasks.applyTransition(
        transitionTask(
          { ...task, updatedAt: base.now() },
          {
            type: "grantAdditionalRounds",
            receiptId: receipt.id,
            additionalRounds
          }
        ),
        base.id()
      );
    }
  };
}

export interface IntegrationFixtureOptions {
  conflict: boolean;
  multiple?: boolean;
  foreignCheckpoint?: boolean;
  state?: TaskRecord["state"];
  pauseBeforeMutation?: boolean;
}

export async function createIntegrationFixture(options: IntegrationFixtureOptions) {
  const base = await createTaskEngineFixture({
    mockScript: [],
    initialState: options.state ?? "Review2"
  });
  const lead = await base.manager.ensureAgentWorktree({
    projectId: base.project.id,
    taskId: "task-1",
    role: "lead",
    baseOid: base.repository.initialOid,
    repositoryRootRealpath: base.project.repositoryRoot,
    commonDirRealpath: base.project.gitCommonDir,
    workerGeneration: base.generation,
    idempotencyKey: "integration-lead"
  });
  const collaborator = await base.manager.ensureAgentWorktree({
    projectId: base.project.id,
    taskId: "task-1",
    role: "collaborator",
    baseOid: base.repository.initialOid,
    repositoryRootRealpath: base.project.repositoryRoot,
    commonDirRealpath: base.project.gitCommonDir,
    workerGeneration: base.generation,
    idempotencyKey: "integration-collaborator"
  });
  await base.repository.writeAt(
    lead.pathRealpath,
    options.conflict ? "shared.txt" : "lead.txt",
    options.conflict ? "lead\n" : "lead\n"
  );
  const leadCheckpoint = await base.manager.createCheckpoint({
    projectId: base.project.id,
    taskId: "task-1",
    worktree: lead,
    authorProvider: "claude",
    purpose: "revision",
    message: "Lead checkpoint",
    checkpointId: "lead-cp-1",
    workerGeneration: base.generation,
    idempotencyKey: "lead-cp-1"
  });
  await base.repository.writeAt(collaborator.pathRealpath, "collaborator.txt", "alternative\n");
  if (options.conflict) {
    await base.repository.writeAt(collaborator.pathRealpath, "shared.txt", "collaborator\n");
  }
  const collaboratorCheckpoint = await base.manager.createCheckpoint({
    projectId: base.project.id,
    taskId: "task-1",
    worktree: collaborator,
    authorProvider: "codex",
    purpose: "implementation",
    message: "Collaborator checkpoint one",
    checkpointId: "collaborator-cp-1",
    workerGeneration: base.generation,
    idempotencyKey: "collaborator-cp-1"
  });
  const collaboratorCheckpoints = [collaboratorCheckpoint];
  if (options.multiple) {
    const currentCollaborator = base.artifacts.getWorktree("task-1", "collaborator");
    if (!currentCollaborator) throw new Error("COLLABORATOR_WORKTREE_NOT_FOUND");
    await base.repository.writeAt(currentCollaborator.pathRealpath, "second.txt", "second\n");
    collaboratorCheckpoints.push(await base.manager.createCheckpoint({
      projectId: base.project.id,
      taskId: "task-1",
      worktree: currentCollaborator,
      authorProvider: "codex",
      purpose: "implementation",
      message: "Collaborator checkpoint two",
      checkpointId: "collaborator-cp-2",
      workerGeneration: base.generation,
      idempotencyKey: "collaborator-cp-2"
    }));
  }

  let foreignCheckpoint: ReturnType<GitArtifactRepository["getCheckpoint"]> = null;
  if (options.foreignCheckpoint) {
    const current = base.tasks.getRequired("task-1");
    const foreignTask: TaskRecord = {
      ...current,
      id: "task-2",
      requestEventId: "message-task-2",
      state: "Preparing",
      version: 1,
      createdAt: base.now(),
      updatedAt: base.now()
    };
    base.tasks.insert(foreignTask);
    const foreignWorktree = await base.manager.ensureAgentWorktree({
      projectId: base.project.id,
      taskId: "task-2",
      role: "collaborator",
      baseOid: base.repository.initialOid,
      repositoryRootRealpath: base.project.repositoryRoot,
      commonDirRealpath: base.project.gitCommonDir,
      workerGeneration: base.generation,
      idempotencyKey: "foreign-worktree"
    });
    await base.repository.writeAt(foreignWorktree.pathRealpath, "foreign.txt", "foreign\n");
    foreignCheckpoint = await base.manager.createCheckpoint({
      projectId: base.project.id,
      taskId: "task-2",
      worktree: foreignWorktree,
      authorProvider: "codex",
      purpose: "implementation",
      message: "Foreign checkpoint",
      checkpointId: "foreign-cp-1",
      workerGeneration: base.generation,
      idempotencyKey: "foreign-cp-1"
    });
  }

  const integrationReserved = Promise.withResolvers<void>();
  const releaseIntegration = Promise.withResolvers<void>();
  const integrationManager = options.pauseBeforeMutation
    ? {
        verifyCheckpointRef: base.manager.verifyCheckpointRef.bind(base.manager),
        async integrateCheckpoint(
          input: Parameters<GitManager["integrateCheckpoint"]>[0]
        ) {
          integrationReserved.resolve();
          await releaseIntegration.promise;
          return base.manager.integrateCheckpoint(input);
        }
      }
    : base.manager;
  const integration = new IntegrationService({
    artifacts: base.artifacts,
    tasks: base.tasks,
    projects: base.repositories.projects,
    events: base.eventStore,
    manager: integrationManager,
    id: base.id,
    now: base.now
  });

  return {
    ...base,
    integration,
    lead,
    collaborator,
    leadCheckpoint,
    collaboratorCheckpoint,
    collaboratorCheckpoints,
    foreignCheckpoint,
    readLead(relativePath: string) {
      return base.repository.readAt(lead.pathRealpath, relativePath);
    },
    async writeLead(relativePath: string, contents: string) {
      await writeFile(join(lead.pathRealpath, relativePath), contents, "utf8");
    },
    async gitAtLead(...argv: string[]) {
      return (await base.repository.run(argv, lead.pathRealpath)).stdout.trim();
    },
    waitUntilIntegrationReserved: () => integrationReserved.promise,
    releaseIntegration: () => releaseIntegration.resolve(),
    spoofNextContinueCommonDir(commonDirRealpath: string) {
      const internals = base.manager as unknown as {
        readService: GitReadService;
      };
      const original = internals.readService;
      let pending = true;
      internals.readService = new Proxy(original, {
        get(target, property, receiver) {
          if (property === "inspectRepository") {
            return async (...args: Parameters<GitReadService["inspectRepository"]>) => {
              const identity = await target.inspectRepository(...args);
              if (!pending) return identity;
              pending = false;
              return { ...identity, commonDirRealpath };
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    }
  };
}

export async function createCandidateFixture() {
  const base = await createTaskEngineFixture({
    mockScript: [],
    initialState: "Review2",
    commandClasses: ["test"],
    maxRunMs: 5_000
  });
  const lead = await base.prepareLead("candidate-lead");
  await base.repository.writeAt(lead.pathRealpath, "greeting.txt", "hello candidate\n");
  const checkpoint = await base.manager.createCheckpoint({
    projectId: base.project.id,
    taskId: "task-1",
    worktree: lead,
    authorProvider: "claude",
    purpose: "revision",
    message: "Candidate revision",
    checkpointId: "lead-revision",
    workerGeneration: base.generation,
    idempotencyKey: "candidate-checkpoint"
  });
  const processRunner = new JournaledProcessRunner({
    journal: base.repositories.operations,
    id: base.id,
    now: base.now,
    terminationGraceMs: 100
  });
  const catalog = {
    get(projectId: string, commandId: string) {
      if (projectId !== base.project.id || commandId !== "unit") return null;
      return {
        commandId: "unit",
        commandClass: "test" as const,
        displayName: "Unit tests",
        executableRealpath: process.execPath,
        argv: ["-e", "process.stdout.write('tests passed')"],
        cwdRealpath: lead.pathRealpath,
        timeoutMs: 5_000,
        network: "none" as const
      };
    }
  };
  const commandRunner = new ApprovedCommandRunner({
    catalog,
    processes: processRunner,
    id: base.id,
    now: base.now
  });
  const git = new GitCommandRunner();
  const candidates = new CandidateService({
    tasks: base.tasks,
    approvals: base.repositories.approvals,
    artifacts: base.artifacts,
    projects: base.repositories.projects,
    manager: base.manager,
    git,
    commands: commandRunner,
    events: base.eventStore,
    id: base.id,
    now: base.now
  });

  return {
    ...base,
    candidates,
    checkpoint,
    catalog,
    gitRunner: git,
    async git(...argv: string[]) {
      return (await base.repository.run(argv)).stdout.trim();
    }
  };
}

export async function createFinalMergeFixture(options: {
  targetCheckedOut: boolean;
  dirty?: boolean;
}) {
  const base = await createCandidateFixture();
  const candidate = await base.candidates.buildVerifiedCandidate({
    taskId: "task-1",
    selectedCheckpointIds: [base.checkpoint.id],
    testCommandIds: ["unit"],
    unresolved: [],
    workerGeneration: base.generation,
    idempotencyKey: "final-candidate"
  });
  if (!options.targetCheckedOut) {
    await base.repository.run(["checkout", "--detach", base.repository.initialOid]);
  }
  if (options.dirty) {
    await base.repository.write("dirty-user-file.txt", "do not overwrite\n");
  }
  const tupleSource = new GitCandidateTupleSource({
    tasks: base.tasks,
    artifacts: base.artifacts,
    projects: base.repositories.projects,
    manager: base.manager,
    git: base.gitRunner
  });
  const finalApproval = new FinalApprovalService({
    tasks: base.tasks,
    approvals: base.repositories.approvals,
    events: base.eventStore,
    tupleSource,
    candidates: { get: (candidateId) => base.artifacts.getCandidate(candidateId) },
    workerGeneration: base.generation,
    id: base.id,
    now: base.now
  });
  const request = await finalApproval.request("task-1", "final-request");
  if (request.kind !== "final_merge") throw new Error("FINAL_REQUEST_TYPE_MISMATCH");
  const approval = await finalApproval.approve({
    taskId: "task-1",
    approvalRequestId: request.id,
    displayed: request.scope,
    workerGeneration: base.generation,
    idempotencyKey: "final-approve"
  });
  const readService = new GitReadService(base.gitRunner);
  const merge = new MergeService({
    finalApproval,
    tasks: base.tasks,
    projects: base.repositories.projects,
    manager: base.manager,
    readService,
    events: base.eventStore,
    id: base.id,
    now: base.now
  });

  return {
    ...base,
    candidate,
    finalApproval,
    approval,
    merge,
    async targetOid() {
      return (await base.repository.run(["rev-parse", "refs/heads/main"])).stdout.trim();
    },
    async ownerHeadOid() {
      return (await base.repository.run(["rev-parse", "HEAD"])).stdout.trim();
    },
    async advanceTargetExternally() {
      if (options.targetCheckedOut) throw new Error("EXTERNAL_ADVANCE_REQUIRES_UNOWNED_TARGET");
      await base.repository.write("external.txt", "external\n");
      await base.repository.run(["add", "--", "external.txt"]);
      await base.repository.run(["commit", "--no-gpg-sign", "-m", "External advance"]);
      const externalOid = (await base.repository.run(["rev-parse", "HEAD"])).stdout.trim();
      await base.repository.run(["update-ref", "refs/heads/main", externalOid, base.repository.initialOid]);
      return externalOid;
    }
  };
}
