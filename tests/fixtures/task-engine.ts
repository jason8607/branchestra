import { randomUUID } from "node:crypto";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, Room, RoomEvent } from "../../src/shared/contracts/domain";
import { GitArtifactRepository } from "../../src/worker/git/git-artifact-repository";
import { GitCommandRunner } from "../../src/worker/git/git-command-runner";
import { GitManager } from "../../src/worker/git/git-manager";
import { GitReadService } from "../../src/worker/git/repository-inspector";
import { JournaledOperationRunner } from "../../src/worker/operations/journaled-operation-runner";
import { RepositoryLock } from "../../src/worker/operations/repository-lock";
import {
  MockProvider,
  type MockProviderStep
} from "../../src/worker/providers/mock-provider";
import type {
  TaskProviderPort
} from "../../src/worker/tasks/provider-port";
import { TaskEngine } from "../../src/worker/tasks/task-engine";
import { TaskService } from "../../src/worker/tasks/task-service";
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
  const allEvents = (): RoomEvent[] => eventStore.after({
    roomId: room.id,
    roomSeq: 0,
    limit: 500
  }).events;

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
  const trackedGit = {
    async run(cwd: string, argv: readonly string[]) {
      gitArgvHistory.push([...argv]);
      return realGit.run(cwd, argv);
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
  const provider: TaskProviderPort = {
    async startRun(request) {
      calls.startRun += 1;
      return mock.startRun(request);
    },
    async resumeRun(request) {
      calls.resumeRun += 1;
      return mock.resumeRun(request);
    },
    async cancelRun(runId, reason) {
      calls.cancelRun += 1;
      return mock.cancelRun(runId, reason);
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
    id,
    now: base.now,
    publish(event) {
      publishOrdering.push(base.events.all().some(({ id: eventId }) => eventId === event.id));
    }
  });
  const lead = () => artifacts.getWorktree("task-1", "lead");

  return {
    engine,
    mock,
    tasks: base.repositories.tasks,
    events: {
      ...base.events,
      types: () => base.events.all().map(({ type }) => type),
      persistedBeforePublish: () => publishOrdering.every(Boolean)
    },
    artifacts,
    journal: base.repositories.operations,
    repository: base.repository,
    manager,
    generation: base.generation,
    providerCalls: () => ({ ...calls }),
    gitMutationCalls: () => gitArgvHistory.map((argv) => argv.join(" ")),
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
