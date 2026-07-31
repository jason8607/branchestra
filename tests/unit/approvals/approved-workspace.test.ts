import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovedWorkspace } from "../../../src/worker/approvals/approved-workspace";
import { WorkspacePathGuard } from "../../../src/worker/git/workspace-path-guard";
import { JournaledOperationRunner } from "../../../src/worker/operations/journaled-operation-runner";
import { OperationJournal } from "../../../src/worker/operations/operation-journal";
import { openTestDatabase } from "../../fixtures/test-database";
import { createRepositories } from "../../../src/worker/storage/repositories";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

async function fixture(options: {
  swapParentOnSecondWritableResolution?: boolean;
  swapLeafAfterSecondWritableResolution?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "branchestra-approved-workspace-"));
  const worktree = join(root, "worktree");
  const common = join(root, "common.git");
  const outside = join(root, "outside");
  await Promise.all([mkdir(worktree), mkdir(common), mkdir(outside)]);
  const testDb = openTestDatabase();
  const repositories = createRepositories(testDb.db);
  repositories.tasks.insert(testDb.records.task);
  cleanup.push(async () => {
    testDb.db.close();
    await rm(testDb.directory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  const realGuard = await WorkspacePathGuard.create({
    repositoryRootRealpath: await realpath(worktree),
    worktreeRootRealpath: await realpath(worktree),
    gitCommonDirRealpath: await realpath(common)
  });
  let writableResolutions = 0;
  const guard = options.swapParentOnSecondWritableResolution
    || options.swapLeafAfterSecondWritableResolution
    ? new Proxy(realGuard, {
        get(target, property, receiver) {
          if (property !== "resolveWritable") return Reflect.get(target, property, receiver);
          return async (candidate: string) => {
            writableResolutions += 1;
            if (writableResolutions === 2 && options.swapParentOnSecondWritableResolution) {
              const parent = join(worktree, "safe");
              await rm(parent, { recursive: true });
              await symlink(outside, parent, "dir");
            }
            const resolved = await target.resolveWritable(candidate);
            if (writableResolutions === 2 && options.swapLeafAfterSecondWritableResolution) {
              await symlink(join(outside, "victim.txt"), resolved);
            }
            return resolved;
          };
        }
      })
    : realGuard;
  let operation = 0;
  return {
    worktree,
    outside,
    workspace: new ApprovedWorkspace(
      guard,
      new JournaledOperationRunner(new OperationJournal(testDb.db)),
      {
        projectId: testDb.records.project.id,
        taskId: testDb.records.task.id,
        commonDirRealpath: testDb.records.project.gitCommonDir,
        workerGeneration: "50000000-0000-4000-8000-000000000001",
        nextOperationId: () => `workspace-operation-${++operation}`,
        now: () => "2026-07-24T10:00:00.000Z"
      }
    )
  };
}

describe("ApprovedWorkspace", () => {
  it("writes and reads text only through the worktree capability", async () => {
    const { workspace, worktree } = await fixture();
    await workspace.writeText("nested/result.txt", "safe");
    await expect(workspace.readText("nested/result.txt")).resolves.toBe("safe");
    await expect(readFile(join(worktree, "nested/result.txt"), "utf8")).resolves.toBe("safe");
    await expect(workspace.writeText("../outside.txt", "unsafe")).rejects.toThrow("PATH_INVALID");
  });

  it("fails closed when a parent is swapped to a symlink immediately before open", async () => {
    const { workspace, worktree, outside } = await fixture({ swapParentOnSecondWritableResolution: true });
    const parent = join(worktree, "safe");
    await mkdir(parent);
    await expect(workspace.writeText("safe/result.txt", "unsafe"))
      .rejects.toThrow(/PATH_ESCAPES_WORKTREE|PATH_CHANGED_DURING_AUTHORIZATION/);
    await expect(readFile(join(outside, "result.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses O_NOFOLLOW when a final-file symlink appears after re-resolution", async () => {
    const { workspace, outside } = await fixture({ swapLeafAfterSecondWritableResolution: true });
    const victim = join(outside, "victim.txt");
    await writeFile(victim, "original");
    await expect(workspace.writeText("result.txt", "unsafe")).rejects.toMatchObject({
      code: expect.stringMatching(/ELOOP|EMLINK/)
    });
    await expect(readFile(victim, "utf8")).resolves.toBe("original");
  });
});
