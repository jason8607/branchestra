import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, Room, RoomEvent } from "../../src/shared/contracts/domain";
import { GitCommandRunner } from "../../src/worker/git/git-command-runner";
import { GitReadService } from "../../src/worker/git/repository-inspector";
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
  const managedWorktreeRoot = await mkdtemp(join(tmpdir(), "branchestra-managed-worktrees-"));
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
