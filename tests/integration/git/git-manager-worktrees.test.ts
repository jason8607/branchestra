import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorktreeRecord } from "../../../src/shared/contracts/domain";
import { createGitManagerFixture } from "../../fixtures/git-repository";

const GENERATION = "00000000-0000-4000-8000-000000000001";

describe("GitManager worktrees", () => {
  it("creates distinct Lead and Collaborator branches from the recorded base exactly once", async () => {
    const fixture = await createGitManagerFixture();
    try {
      const common = {
        projectId: fixture.project.id,
        taskId: fixture.task.id,
        baseOid: fixture.repository.initialOid,
        repositoryRootRealpath: fixture.repository.root,
        commonDirRealpath: fixture.repository.commonDirRealpath,
        workerGeneration: GENERATION
      };
      const lead = await fixture.manager.ensureAgentWorktree({
        ...common,
        role: "lead",
        idempotencyKey: "worktree-lead"
      });
      const collaborator = await fixture.manager.ensureAgentWorktree({
        ...common,
        role: "collaborator",
        idempotencyKey: "worktree-collaborator"
      });

      expect(lead.branchRef).toBe(`refs/heads/branchestra/${fixture.task.id}/lead`);
      expect(collaborator.branchRef).toBe(`refs/heads/branchestra/${fixture.task.id}/collaborator`);
      expect(lead.pathRealpath).not.toBe(collaborator.pathRealpath);
      await expect(fixture.manager.ensureAgentWorktree({
        ...common,
        role: "lead",
        idempotencyKey: "worktree-lead"
      })).resolves.toMatchObject({ id: lead.id });
    } finally {
      await fixture.cleanup();
    }
  });

  it("recovers a branch-created/worktree-missing partial state without moving the branch", async () => {
    const fixture = await createGitManagerFixture();
    try {
      const branch = `branchestra/${fixture.task.id}/lead`;
      await fixture.repository.run(["branch", branch, fixture.repository.initialOid]);
      const lead = await fixture.manager.ensureAgentWorktree({
        projectId: fixture.project.id,
        taskId: fixture.task.id,
        role: "lead",
        baseOid: fixture.repository.initialOid,
        repositoryRootRealpath: fixture.repository.root,
        commonDirRealpath: fixture.repository.commonDirRealpath,
        workerGeneration: GENERATION,
        idempotencyKey: "recover-branch"
      });

      expect(await fixture.repository.run(["rev-parse", `refs/heads/${branch}`]))
        .toMatchObject({ stdout: `${fixture.repository.initialOid}\n` });
      expect(fixture.gitArgvHistory.some(({ argv }) =>
        argv[0] === "worktree" && argv[1] === "add"
        && argv[2] === lead.pathRealpath && argv[3] === branch)).toBe(true);
      expect(fixture.journal.getByIdempotencyKey("recover-branch")?.status).toBe("completed");
    } finally {
      await fixture.cleanup();
    }
  });

  it("preserves an external branch at the wrong OID and records needs_attention", async () => {
    const fixture = await createGitManagerFixture();
    try {
      await fixture.repository.write("external.txt", "external\n");
      await fixture.repository.run(["add", "--", "external.txt"]);
      await fixture.repository.run(["commit", "--no-gpg-sign", "-m", "External commit"]);
      const wrongOid = (await fixture.repository.run(["rev-parse", "HEAD"])).stdout.trim();
      const branchRef = `refs/heads/branchestra/${fixture.task.id}/lead`;
      await fixture.repository.run(["branch", branchRef.slice("refs/heads/".length), wrongOid]);

      await expect(fixture.manager.ensureAgentWorktree({
        projectId: fixture.project.id,
        taskId: fixture.task.id,
        role: "lead",
        baseOid: fixture.repository.initialOid,
        repositoryRootRealpath: fixture.repository.root,
        commonDirRealpath: fixture.repository.commonDirRealpath,
        workerGeneration: GENERATION,
        idempotencyKey: "wrong-branch"
      })).rejects.toThrow("WORKTREE_STATE_CONFLICT");

      expect((await fixture.repository.run(["rev-parse", branchRef])).stdout.trim()).toBe(wrongOid);
      expect(fixture.journal.getByIdempotencyKey("wrong-branch")?.status).toBe("needs_attention");
      expect(fixture.gitArgvHistory.some(({ argv }) =>
        ["reset", "clean", "stash"].includes(argv[0] ?? "")
        || (argv[0] === "worktree" && argv[1] === "remove")
        || argv.includes("--force"))).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not reuse or delete a pre-existing target directory", async () => {
    const fixture = await createGitManagerFixture();
    try {
      const target = join(
        fixture.managedWorktreeRoot,
        fixture.project.id,
        fixture.task.id,
        "lead"
      );
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "keep.txt"), "keep\n");

      await expect(fixture.manager.ensureAgentWorktree({
        projectId: fixture.project.id,
        taskId: fixture.task.id,
        role: "lead",
        baseOid: fixture.repository.initialOid,
        repositoryRootRealpath: fixture.repository.root,
        commonDirRealpath: fixture.repository.commonDirRealpath,
        workerGeneration: GENERATION,
        idempotencyKey: "existing-directory"
      })).rejects.toThrow("WORKTREE_STATE_CONFLICT");

      await expect(fixture.repository.readAt(target, "keep.txt")).resolves.toBe("keep\n");
      expect(fixture.journal.getByIdempotencyKey("existing-directory")?.status).toBe("needs_attention");
    } finally {
      await fixture.cleanup();
    }
  });

  it("serializes concurrent tasks that mutate the same repository", async () => {
    const firstAdd = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    let activeAdds = 0;
    let maximumActiveAdds = 0;
    let adds = 0;
    const fixture = await createGitManagerFixture({
      async afterGitRun(_cwd, argv) {
        if (argv[0] !== "worktree" || argv[1] !== "add") return;
        activeAdds += 1;
        adds += 1;
        maximumActiveAdds = Math.max(maximumActiveAdds, activeAdds);
        if (adds === 1) {
          firstAdd.resolve();
          await releaseFirst.promise;
        }
        activeAdds -= 1;
      }
    });
    try {
      const secondTask = fixture.insertTask("task-2");
      const ensure = (taskId: string, key: string) => fixture.manager.ensureAgentWorktree({
        projectId: fixture.project.id,
        taskId,
        role: "lead" as const,
        baseOid: fixture.repository.initialOid,
        repositoryRootRealpath: fixture.repository.root,
        commonDirRealpath: fixture.repository.commonDirRealpath,
        workerGeneration: GENERATION,
        idempotencyKey: key
      });
      const first = ensure(fixture.task.id, "same-repository-first");
      await firstAdd.promise;
      const second = ensure(secondTask.id, "same-repository-second");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(adds).toBe(1);
      releaseFirst.resolve();
      const results = await Promise.all([first, second]);
      expect(results.map(({ taskId }) => taskId).sort()).toEqual(["task-1", "task-2"]);
      expect(maximumActiveAdds).toBe(1);
    } finally {
      releaseFirst.resolve();
      await fixture.cleanup();
    }
  });

  it("allows mutations on distinct repositories to proceed in parallel", async () => {
    const release = Promise.withResolvers<void>();
    const bothEntered = Promise.withResolvers<void>();
    let entered = 0;
    const lock = new (await import("../../../src/worker/operations/repository-lock")).RepositoryLock();
    const options = {
      lock,
      async afterGitRun(_cwd: string, argv: readonly string[]) {
        if (argv[0] !== "worktree" || argv[1] !== "add") return;
        entered += 1;
        if (entered === 2) bothEntered.resolve();
        await release.promise;
      }
    };
    const first = await createGitManagerFixture(options);
    const second = await createGitManagerFixture(options);
    let results: Promise<WorktreeRecord[]> | undefined;
    try {
      const ensure = (fixture: typeof first, key: string) => fixture.manager.ensureAgentWorktree({
        projectId: fixture.project.id,
        taskId: fixture.task.id,
        role: "lead",
        baseOid: fixture.repository.initialOid,
        repositoryRootRealpath: fixture.repository.root,
        commonDirRealpath: fixture.repository.commonDirRealpath,
        workerGeneration: GENERATION,
        idempotencyKey: key
      });
      results = Promise.all([
        ensure(first, "distinct-repository-first"),
        ensure(second, "distinct-repository-second")
      ]);
      await Promise.race([
        bothEntered.promise,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error("distinct repositories were globally serialized")),
          5_000
        ))
      ]);
      expect(entered).toBe(2);
      release.resolve();
      await expect(results).resolves.toHaveLength(2);
    } finally {
      release.resolve();
      await results?.catch(() => undefined);
      await first.cleanup();
      await second.cleanup();
    }
  });

  it("retains a worktree when cancellation is observed immediately after worktree add", async () => {
    let cancelOnce = true;
    const fixture = await createGitManagerFixture({
      afterGitRun(_cwd, argv) {
        if (cancelOnce && argv[0] === "worktree" && argv[1] === "add") {
          cancelOnce = false;
          throw new Error("CANCELLED_AFTER_WORKTREE_ADD");
        }
      }
    });
    try {
      const lead = await fixture.manager.ensureAgentWorktree({
        projectId: fixture.project.id,
        taskId: fixture.task.id,
        role: "lead",
        baseOid: fixture.repository.initialOid,
        repositoryRootRealpath: fixture.repository.root,
        commonDirRealpath: fixture.repository.commonDirRealpath,
        workerGeneration: GENERATION,
        idempotencyKey: "cancel-after-add"
      });

      expect((await fixture.manager.getReadService().listWorktrees(fixture.repository.root))
        .some(({ pathRealpath }) => pathRealpath === lead.pathRealpath)).toBe(true);
      expect((await fixture.repository.run(["rev-parse", lead.branchRef])).stdout.trim())
        .toBe(fixture.repository.initialOid);
      expect(fixture.journal.getByIdempotencyKey("cancel-after-add")?.status).toBe("completed");
      expect(fixture.artifacts.getWorktree(fixture.task.id, "lead")).toMatchObject({ id: lead.id });
    } finally {
      await fixture.cleanup();
    }
  });
});
