import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, Room, TaskRecord, WorktreeRecord } from "../../src/shared/contracts/domain";
import { GitArtifactRepository } from "../../src/worker/git/git-artifact-repository";
import { GitCommandRunner, type GitCommandResult } from "../../src/worker/git/git-command-runner";
import { GitManager } from "../../src/worker/git/git-manager";
import { GitReadService } from "../../src/worker/git/repository-inspector";
import type { WorkspaceGuardIdentity } from "../../src/worker/git/workspace-path-guard";
import { JournaledOperationRunner } from "../../src/worker/operations/journaled-operation-runner";
import { RepositoryLock } from "../../src/worker/operations/repository-lock";
import { createRepositories } from "../../src/worker/storage/repositories";
import { openTestDatabase } from "./test-database";

export interface GitRepositoryFixture {
  root: string;
  commonDirRealpath: string;
  initialOid: string;
  run(argv: readonly string[], cwd?: string): Promise<GitCommandResult>;
  write(relativePath: string, contents: string | Uint8Array): Promise<void>;
  writeAt(root: string, relativePath: string, contents: string | Uint8Array): Promise<void>;
  readAt(root: string, relativePath: string): Promise<string>;
  cleanup(): void | Promise<void>;
}

export interface GitRepositoryFixtureDependencies {
  runGit?(args: readonly string[]): void;
}

const runGitWithExecFile = (args: readonly string[]): void => {
  execFileSync("/usr/bin/git", [...args]);
};

export function createGitRepository(
  dependencies: GitRepositoryFixtureDependencies = {}
): GitRepositoryFixture {
  const root = mkdtempSync(join(tmpdir(), "branchestra-git-"));
  let initialOid: string;
  try {
    const runGit = dependencies.runGit ?? runGitWithExecFile;
    runGit(["init", "-b", "main", root]);
    writeFileSync(join(root, "README.md"), "# Fixture\n", "utf8");
    mkdirSync(join(root, "nested"));
    runGit(["-C", root, "add", "README.md"]);
    runGit([
      "-C", root,
      "-c", "user.name=Branchestra",
      "-c", "user.email=branchestra@invalid",
      "commit", "--no-gpg-sign", "-m", "Initial commit"
    ]);
    initialOid = execFileSync("/usr/bin/git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }

  return {
    root,
    commonDirRealpath: realpathSync(join(root, ".git")),
    initialOid,
    async run(argv, cwd = root) {
      return new GitCommandRunner().run(cwd, argv);
    },
    async write(relativePath, contents) {
      const target = join(root, relativePath);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, contents);
    },
    async writeAt(worktreeRoot, relativePath, contents) {
      const target = join(worktreeRoot, relativePath);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, contents);
    },
    readAt(worktreeRoot, relativePath) {
      return readFile(join(worktreeRoot, relativePath), "utf8");
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

export async function createGitRepositoryFixture(
  options: { objectFormat?: "sha1" | "sha256" } = {}
): Promise<GitRepositoryFixture> {
  const root = await mkdtemp(join(tmpdir(), "branchestra git repository "));
  const git = new GitCommandRunner();
  try {
    await git.run(root, [
      "init",
      "-b", "main",
      ...(options.objectFormat === undefined ? [] : [`--object-format=${options.objectFormat}`])
    ]);
    await writeFile(join(root, "README.md"), "# Fixture\n", "utf8");
    await git.run(root, ["add", "--", "README.md"]);
    await git.run(root, ["commit", "--no-gpg-sign", "-m", "Initial commit"]);
    const initialOid = (await git.run(root, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
    const commonDirOutput = (await git.run(root, [
      "rev-parse", "--path-format=absolute", "--git-common-dir"
    ])).stdout.trim();
    const commonDirRealpath = await realpath(commonDirOutput);
    return {
      root: await realpath(root),
      commonDirRealpath,
      initialOid,
      run(argv, cwd = root) {
        return git.run(cwd, argv);
      },
      async write(relativePath, contents) {
        const target = join(root, relativePath);
        await mkdir(join(target, ".."), { recursive: true });
        await writeFile(target, contents);
      },
      async writeAt(worktreeRoot, relativePath, contents) {
        const target = join(worktreeRoot, relativePath);
        await mkdir(join(target, ".."), { recursive: true });
        await writeFile(target, contents);
      },
      readAt(worktreeRoot, relativePath) {
        return readFile(join(worktreeRoot, relativePath), "utf8");
      },
      async cleanup() {
        await rm(root, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export interface PathGuardFixture extends WorkspaceGuardIdentity {
  identity: WorkspaceGuardIdentity;
  commonDirRealpath: string;
  cleanup(): Promise<void>;
}

export async function makePathGuardFixture(): Promise<PathGuardFixture> {
  const repository = await createGitRepositoryFixture();
  const worktreePath = join(repository.root, "linked guard worktree");
  const outsidePath = join(repository.root, "guard outside");
  try {
    await repository.run(["worktree", "add", "-b", "guard-fixture", worktreePath]);
    await mkdir(outsidePath);
    await writeFile(join(outsidePath, "secret.txt"), "secret\n");
    await symlink(outsidePath, join(worktreePath, "external-link"), "dir");
    const identity = {
      repositoryRootRealpath: repository.root,
      worktreeRootRealpath: await realpath(worktreePath),
      gitCommonDirRealpath: repository.commonDirRealpath
    };
    return {
      ...identity,
      identity,
      commonDirRealpath: repository.commonDirRealpath,
      async cleanup() {
        await repository.cleanup();
      }
    };
  } catch (error) {
    await repository.cleanup();
    throw error;
  }
}

export interface GitManagerFixtureOptions {
  repository?: GitRepositoryFixture;
  objectFormat?: "sha1" | "sha256";
  lock?: RepositoryLock;
  beforeGitRun?(cwd: string, argv: readonly string[]): void | Promise<void>;
  afterGitRun?(cwd: string, argv: readonly string[]): void | Promise<void>;
}

export interface GitManagerFixture {
  repository: GitRepositoryFixture;
  project: Project;
  room: Room;
  task: TaskRecord;
  manager: GitManager;
  artifacts: GitArtifactRepository;
  repositories: ReturnType<typeof createRepositories>;
  journal: ReturnType<typeof createRepositories>["operations"];
  db: ReturnType<typeof openTestDatabase>["db"];
  lock: RepositoryLock;
  managedWorktreeRoot: string;
  gitArgvHistory: Array<{ cwd: string; argv: readonly string[] }>;
  createManager(): GitManager;
  insertTask(taskId: string): TaskRecord;
  cleanup(): Promise<void>;
}

export async function createGitManagerFixture(
  options: GitManagerFixtureOptions = {}
): Promise<GitManagerFixture> {
  const ownsRepository = options.repository === undefined;
  const repository = options.repository ?? await createGitRepositoryFixture({
    ...(options.objectFormat === undefined ? {} : { objectFormat: options.objectFormat })
  });
  const managedWorktreeRoot = await mkdtemp(join(tmpdir(), "branchestra-managed-worktrees-"));
  const database = openTestDatabase();
  const repositories = createRepositories(database.db);
  const artifacts = new GitArtifactRepository(database.db);
  const lock = options.lock ?? new RepositoryLock();
  const gitArgvHistory: Array<{ cwd: string; argv: readonly string[] }> = [];
  const realGit = new GitCommandRunner();
  const trackedGit = {
    async run(cwd: string, argv: readonly string[]) {
      gitArgvHistory.push({ cwd, argv: [...argv] });
      await options.beforeGitRun?.(cwd, argv);
      const result = await realGit.run(cwd, argv);
      await options.afterGitRun?.(cwd, argv);
      return result;
    },
    async runBuffer(cwd: string, argv: readonly string[]) {
      gitArgvHistory.push({ cwd, argv: [...argv] });
      await options.beforeGitRun?.(cwd, argv);
      const result = await realGit.runBuffer(cwd, argv);
      await options.afterGitRun?.(cwd, argv);
      return result;
    }
  };
  const createdAt = "2026-07-24T10:00:00.000Z";
  const project: Project = {
    id: "10000000-0000-4000-8000-000000000006",
    repositoryRoot: repository.root,
    gitCommonDir: repository.commonDirRealpath,
    displayName: "git-manager-fixture",
    headOid: repository.initialOid,
    defaultBranch: "main",
    createdAt
  };
  const room: Room = {
    id: "20000000-0000-4000-8000-000000000006",
    projectId: project.id,
    title: "Git manager fixture",
    createdAt
  };
  repositories.projects.insert(project);
  repositories.rooms.insert(room);

  const makeTask = (taskId: string): TaskRecord => ({
    id: taskId,
    roomId: room.id,
    projectId: project.id,
    requestEventId: `request-${taskId}`,
    requestText: "Implement fixture task",
    leadProvider: "claude",
    targetRef: "refs/heads/main",
    baseOid: repository.initialOid,
    state: "Preparing",
    interruptedFromState: null,
    collaborationRoundsUsed: 0,
    collaborationRoundBudget: 2,
    humanRevisionCount: 0,
    revisionKind: null,
    scopeApprovalId: null,
    activeCandidateId: null,
    failure: null,
    version: 1,
    createdAt,
    updatedAt: createdAt
  });
  const task = makeTask("task-1");
  repositories.tasks.insert(task);
  let timestampTick = 0;
  const now = () => `2026-07-24T10:00:${String(timestampTick++).padStart(2, "0")}.000Z`;
  const journal = repositories.operations;
  const createManager = () => new GitManager({
    git: trackedGit,
    readService: new GitReadService(trackedGit),
    artifacts,
    projects: repositories.projects,
    tasks: repositories.tasks,
    lock,
    operations: new JournaledOperationRunner(journal),
    journal,
    managedWorktreeRoot,
    id: randomUUID,
    now
  });
  const manager = createManager();
  let closed = false;
  return {
    repository,
    project,
    room,
    task,
    manager,
    artifacts,
    repositories,
    journal,
    db: database.db,
    lock,
    managedWorktreeRoot,
    gitArgvHistory,
    createManager,
    insertTask(taskId) {
      const inserted = makeTask(taskId);
      repositories.tasks.insert(inserted);
      return inserted;
    },
    async cleanup() {
      if (closed) return;
      closed = true;
      database.db.close();
      await Promise.all([
        ownsRepository ? repository.cleanup() : Promise.resolve(),
        rm(managedWorktreeRoot, { recursive: true, force: true }),
        rm(database.directory, { recursive: true, force: true })
      ]);
    }
  };
}

export interface PreparedLeadFixture extends GitManagerFixture {
  lead: WorktreeRecord;
  hookSentinel: string;
  installHookThatWrites(hookName: string, sentinel: string): Promise<void>;
  pathExists(path: string): Promise<boolean>;
  git(...argv: string[]): Promise<string>;
}

export async function createPreparedLeadFixture(
  options: GitManagerFixtureOptions = {}
): Promise<PreparedLeadFixture> {
  const fixture = await createGitManagerFixture(options);
  try {
    const lead = await fixture.manager.ensureAgentWorktree({
      projectId: fixture.project.id,
      taskId: fixture.task.id,
      role: "lead",
      baseOid: fixture.repository.initialOid,
      repositoryRootRealpath: fixture.repository.root,
      commonDirRealpath: fixture.repository.commonDirRealpath,
      workerGeneration: "00000000-0000-4000-8000-000000000001",
      idempotencyKey: "prepare-lead"
    });
    const hookSentinel = join(fixture.managedWorktreeRoot, "hook-ran");
    return {
      ...fixture,
      lead,
      hookSentinel,
      async installHookThatWrites(hookName, sentinel) {
        const hookPath = join(fixture.repository.commonDirRealpath, "hooks", hookName);
        await mkdir(join(hookPath, ".."), { recursive: true });
        await writeFile(hookPath, `#!/bin/sh\nprintf hook-ran > '${sentinel}'\n`, "utf8");
        await chmod(hookPath, 0o755);
      },
      async pathExists(path) {
        try {
          await access(path);
          return true;
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
          throw error;
        }
      },
      async git(...argv) {
        return (await fixture.repository.run(argv)).stdout.trim();
      }
    };
  } catch (error) {
    await fixture.cleanup();
    throw error;
  }
}
