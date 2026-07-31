import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspacePathGuard } from "../../../src/worker/git/workspace-path-guard";
import { makePathGuardFixture as makeSharedPathGuardFixture } from "../../fixtures/git-repository";

const cleanupRoots: string[] = [];

async function makeFixture(): Promise<{
  root: string;
  worktree: string;
  common: string;
  outside: string;
  guard: WorkspacePathGuard;
}> {
  const root = await mkdtemp(join(tmpdir(), "branchestra guard "));
  cleanupRoots.push(root);
  const worktree = join(root, "worktree");
  const common = join(root, "common.git");
  const outside = join(root, "outside");
  await Promise.all([mkdir(worktree), mkdir(common), mkdir(outside)]);
  await writeFile(join(worktree, "tracked.txt"), "tracked\n");
  await writeFile(join(outside, "secret.txt"), "secret\n");
  await writeFile(join(worktree, ".git"), `gitdir: ${join(common, "worktrees", "linked")}\n`);
  await symlink(outside, join(worktree, "external-link"), "dir");
  const guard = await WorkspacePathGuard.create({
    repositoryRootRealpath: await realpath(worktree),
    worktreeRootRealpath: await realpath(worktree),
    gitCommonDirRealpath: await realpath(common)
  });
  return {
    root,
    worktree: await realpath(worktree),
    common: await realpath(common),
    outside: await realpath(outside),
    guard
  };
}

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("WorkspacePathGuard", () => {
  it("uses the shared linked-worktree fixture for common-dir and external-link rejection", async () => {
    const fixture = await makeSharedPathGuardFixture();
    try {
      const guard = await WorkspacePathGuard.create(fixture.identity);
      await expect(guard.resolveWritable(fixture.commonDirRealpath)).rejects.toThrow("PATH_IS_GIT_METADATA");
      await expect(guard.resolveWritable("external-link/new.txt")).rejects.toThrow("PATH_ESCAPES_WORKTREE");
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    ["traversal", "../outside/secret.txt", "PATH_INVALID"],
    ["absolute escape", "__OUTSIDE__", "PATH_ESCAPES_WORKTREE"],
    ["linked-worktree metadata", ".git", "PATH_IS_GIT_METADATA"],
    ["metadata child", ".git/config", "PATH_IS_GIT_METADATA"],
    ["common directory", "__COMMON__", "PATH_IS_GIT_METADATA"],
    ["external symlink leaf", "external-link/secret.txt", "PATH_ESCAPES_WORKTREE"],
    ["external symlink ancestor for a new file", "external-link/new.txt", "PATH_ESCAPES_WORKTREE"]
  ])("rejects %s", async (_label, rawCandidate, code) => {
    const fixture = await makeFixture();
    const candidate = rawCandidate === "__OUTSIDE__"
      ? join(fixture.outside, "secret.txt")
      : rawCandidate === "__COMMON__" ? fixture.common : rawCandidate;

    await expect(fixture.guard.resolveWritable(candidate)).rejects.toThrow(code);
  });

  it.each(["", "nested//file.txt", "nested/\0file.txt", "nested/"])(
    "rejects an invalid path component in %j",
    async (candidate) => {
      const { guard } = await makeFixture();
      await expect(guard.resolveWritable(candidate)).rejects.toThrow("PATH_INVALID");
    }
  );

  it("rejects traversal even when normalization would land back inside the worktree", async () => {
    const { guard } = await makeFixture();
    await expect(guard.resolveReadable("nested/../tracked.txt")).rejects.toThrow("PATH_INVALID");
  });

  it("authorizes canonical existing files and nonexistent leaves below the worktree", async () => {
    const { guard, worktree } = await makeFixture();
    await expect(guard.resolveReadable("tracked.txt")).resolves.toBe(join(worktree, "tracked.txt"));
    await expect(guard.resolveWritable("nested/new.txt")).resolves.toBe(join(worktree, "nested", "new.txt"));
  });

  it("rejects a symlink ancestor swapped after guard construction", async () => {
    const fixture = await makeFixture();
    const parent = join(fixture.worktree, "safe");
    await mkdir(parent);
    await rm(parent, { recursive: true });
    await symlink(fixture.outside, parent, "dir");
    await expect(fixture.guard.resolveWritable("safe/new.txt")).rejects.toThrow("PATH_ESCAPES_WORKTREE");
  });

  it("requires child CWDs to exist as directories in the assigned worktree", async () => {
    const { guard, worktree } = await makeFixture();
    const nested = join(worktree, "nested cwd");
    await mkdir(nested);
    await expect(guard.assertChildCwd("nested cwd")).resolves.toBe(await realpath(nested));
    await expect(guard.assertChildCwd("missing")).rejects.toThrow("PATH_NOT_DIRECTORY");
    await expect(guard.assertChildCwd("tracked.txt")).rejects.toThrow("PATH_NOT_DIRECTORY");
  });

  it("rejects metadata reached through a symlink inside the worktree", async () => {
    const fixture = await makeFixture();
    const metadataLink = join(fixture.worktree, "metadata-link");
    await mkdir(dirname(metadataLink), { recursive: true });
    await symlink(fixture.common, metadataLink, "dir");
    await expect(fixture.guard.resolveReadable("metadata-link/config")).rejects.toThrow("PATH_IS_GIT_METADATA");
  });

  it("rejects a symlink alias to the linked-worktree .git indirection file", async () => {
    const fixture = await makeFixture();
    await symlink(join(fixture.worktree, ".git"), join(fixture.worktree, "git-file-alias"));
    await expect(fixture.guard.resolveReadable("git-file-alias")).rejects.toThrow("PATH_IS_GIT_METADATA");
  });
});
