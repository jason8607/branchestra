import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitCommandRunner } from "../../../src/worker/git/git-command-runner";
import { GitReadService } from "../../../src/worker/git/repository-inspector";
import { createGitRepositoryFixture, type GitRepositoryFixture } from "../../fixtures/git-repository";

const fixtures: GitRepositoryFixture[] = [];
const extraRoots: string[] = [];

async function makeFixture(): Promise<GitRepositoryFixture> {
  const fixture = await createGitRepositoryFixture();
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => fixture.cleanup()));
  await Promise.all(extraRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("GitReadService repository identity", () => {
  it("inspects a selected nested path in a repository whose path contains spaces", async () => {
    const fixture = await makeFixture();
    const nested = join(fixture.root, "nested path");
    await mkdir(nested);
    const service = new GitReadService(new GitCommandRunner());

    const identity = await service.inspectRepository(nested);

    expect(identity).toEqual({
      rootRealpath: await realpath(fixture.root),
      commonDirRealpath: fixture.commonDirRealpath,
      gitDirRealpath: fixture.commonDirRealpath,
      headOid: fixture.initialOid,
      headRef: "refs/heads/main"
    });
  });

  it("rejects bare, detached, and unborn repositories", async () => {
    const service = new GitReadService(new GitCommandRunner());
    const bare = await mkdtemp(join(tmpdir(), "branchestra bare "));
    const unborn = await mkdtemp(join(tmpdir(), "branchestra unborn "));
    extraRoots.push(bare, unborn);
    await new GitCommandRunner().run(bare, ["init", "--bare"]);
    await new GitCommandRunner().run(unborn, ["init", "-b", "main"]);
    const fixture = await makeFixture();
    await fixture.run(["checkout", "--detach", fixture.initialOid]);

    await expect(service.inspectRepository(bare)).rejects.toThrow("REPOSITORY_BARE");
    await expect(service.inspectRepository(unborn)).rejects.toThrow("REPOSITORY_HEAD_MISSING");
    await expect(service.inspectRepository(fixture.root)).rejects.toThrow("REPOSITORY_HEAD_DETACHED");
  });

  it("accepts a real SHA-256 repository identity with a 64-character object ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "branchestra sha256 "));
    extraRoots.push(root);
    const git = new GitCommandRunner();
    await git.run(root, ["init", "--object-format=sha256", "-b", "main"]);
    await writeFile(join(root, "README.md"), "sha256\n");
    await git.run(root, ["add", "--", "README.md"]);
    await git.run(root, ["commit", "--no-gpg-sign", "-m", "SHA-256 initial"]);

    const identity = await new GitReadService(git).inspectRepository(root);

    expect(identity.headOid).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.headRef).toBe("refs/heads/main");
  });
});

describe("GitReadService read-only queries", () => {
  it("parses porcelain-v2 -z rename and untracked records", async () => {
    const fixture = await makeFixture();
    await fixture.run(["mv", "README.md", "renamed file.txt"]);
    await fixture.write("untracked file.txt", "untracked\n");
    const service = new GitReadService(new GitCommandRunner());

    const status = await service.status({
      repositoryRootRealpath: fixture.root,
      worktreePathRealpath: fixture.root
    });

    expect(status.clean).toBe(false);
    expect(status.entries.join("\n")).toContain("renamed file.txt");
    expect(status.entries.join("\n")).toContain("README.md");
    expect(status.entries.join("\n")).toContain("untracked file.txt");
    expect(status.inProgressOperation).toBeNull();
  });

  it.each([
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["REBASE_HEAD", "rebase"],
    ["BISECT_LOG", "bisect"]
  ])("detects the %s sentinel through git-path", async (sentinel, expected) => {
    const fixture = await makeFixture();
    const sentinelPath = (await fixture.run([
      "rev-parse", "--path-format=absolute", "--git-path", sentinel
    ])).stdout.trim();
    await writeFile(sentinelPath, `${fixture.initialOid}\n`);
    const service = new GitReadService(new GitCommandRunner());
    await expect(service.status({
      repositoryRootRealpath: fixture.root,
      worktreePathRealpath: fixture.root
    })).resolves.toMatchObject({ inProgressOperation: expected });
  });

  it("returns a patch and robust numstat data for text, binary, and renamed paths", async () => {
    const fixture = await makeFixture();
    await fixture.write("README.md", "# Fixture\nsecond line\n");
    await fixture.write("binary.dat", Buffer.from([0, 1, 2, 255]));
    await fixture.run(["add", "--", "README.md", "binary.dat"]);
    await fixture.run(["commit", "--no-gpg-sign", "-m", "Add data"]);
    const toOid = (await fixture.run(["rev-parse", "HEAD"])).stdout.trim();
    const service = new GitReadService(new GitCommandRunner());

    const diff = await service.diff({
      repositoryRootRealpath: fixture.root,
      fromOid: fixture.initialOid,
      toOid,
      pathspec: ["README.md", "binary.dat"]
    });

    expect(diff.patch).toContain("second line");
    expect(diff.files).toEqual(expect.arrayContaining([
      { path: "README.md", status: "M", additions: 1, deletions: 0 },
      { path: "binary.dat", status: "A", additions: 0, deletions: 0 }
    ]));
  });

  it("shows a path only after -- and returns bounded logs", async () => {
    const fixture = await makeFixture();
    await fixture.write("--odd name.txt", "odd\n");
    await fixture.run(["add", "--", "--odd name.txt"]);
    await fixture.run(["commit", "--no-gpg-sign", "-m", "Odd path"]);
    const head = (await fixture.run(["rev-parse", "HEAD"])).stdout.trim();
    const service = new GitReadService(new GitCommandRunner());

    await expect(service.show({ repositoryRootRealpath: fixture.root, oid: head, path: "--odd name.txt" }))
      .resolves.toContain("+odd");
    const log = await service.log({ repositoryRootRealpath: fixture.root, startOid: head, maxCount: 2 });
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ oid: head, subject: "Odd path" });
  });

  it.each([0, -1, 201, 1.5])("rejects an out-of-range log count %s", async (maxCount) => {
    const fixture = await makeFixture();
    const service = new GitReadService(new GitCommandRunner());
    await expect(service.log({
      repositoryRootRealpath: fixture.root,
      startOid: fixture.initialOid,
      maxCount
    })).rejects.toThrow("GIT_LOG_COUNT_INVALID");
  });

  it.each([
    ["diff OID", async (service: GitReadService, fixture: GitRepositoryFixture) => service.diff({ repositoryRootRealpath: fixture.root, fromOid: "HEAD" })],
    ["show OID", async (service: GitReadService, fixture: GitRepositoryFixture) => service.show({ repositoryRootRealpath: fixture.root, oid: "a".repeat(41) })],
    ["log OID", async (service: GitReadService, fixture: GitRepositoryFixture) => service.log({ repositoryRootRealpath: fixture.root, startOid: "-bad", maxCount: 1 })],
    ["absolute path", async (service: GitReadService, fixture: GitRepositoryFixture) => service.show({ repositoryRootRealpath: fixture.root, oid: fixture.initialOid, path: "/etc/passwd" })],
    ["traversal pathspec", async (service: GitReadService, fixture: GitRepositoryFixture) => service.diff({ repositoryRootRealpath: fixture.root, fromOid: fixture.initialOid, pathspec: ["../secret"] })],
    ["pathspec magic", async (service: GitReadService, fixture: GitRepositoryFixture) => service.diff({ repositoryRootRealpath: fixture.root, fromOid: fixture.initialOid, pathspec: [":(top,glob)**"] })],
    ["NUL pathspec", async (service: GitReadService, fixture: GitRepositoryFixture) => service.diff({ repositoryRootRealpath: fixture.root, fromOid: fixture.initialOid, pathspec: ["bad\0path"] })]
  ])("rejects invalid %s", async (_label, invoke) => {
    const fixture = await makeFixture();
    const service = new GitReadService(new GitCommandRunner());
    await expect(invoke(service, fixture)).rejects.toThrow(/GIT_(OID|PATHSPEC)_INVALID/);
  });

  it("accepts exactly 40- and 64-character lowercase hexadecimal object IDs before execution", async () => {
    const calls: readonly string[][] = [];
    const git = {
      async run(_cwd: string, argv: readonly string[]) {
        (calls as string[][]).push([...argv]);
        return { stdout: "", stderr: "" };
      },
      async runBuffer() { return Buffer.alloc(0); }
    };
    const service = new GitReadService(git);
    await service.show({ repositoryRootRealpath: "/repo", oid: "a".repeat(40) });
    await service.show({ repositoryRootRealpath: "/repo", oid: "b".repeat(64) });
    expect(calls).toEqual([
      ["show", "a".repeat(40)],
      ["show", "b".repeat(64)]
    ]);
  });

  it("parses linked worktree branch ownership, locked state, and detached state from -z porcelain", async () => {
    const fixture = await makeFixture();
    const linked = join(fixture.root, "linked worktree");
    const detached = join(fixture.root, "detached worktree");
    await fixture.run(["worktree", "add", "-b", "feature/owned", linked]);
    await fixture.run(["worktree", "lock", "--reason", "task owns it", linked]);
    await fixture.run(["worktree", "add", "--detach", detached, fixture.initialOid]);
    const service = new GitReadService(new GitCommandRunner());

    const worktrees = await service.listWorktrees(fixture.root);

    expect(worktrees).toEqual(expect.arrayContaining([
      {
        pathRealpath: await realpath(linked),
        headOid: fixture.initialOid,
        branchRef: "refs/heads/feature/owned",
        locked: true
      },
      {
        pathRealpath: await realpath(detached),
        headOid: fixture.initialOid,
        branchRef: null,
        locked: false
      }
    ]));
  });

  it("rejects a non-branch ref in worktree porcelain", async () => {
    const fixture = await makeFixture();
    const git = {
      async run() { return { stdout: "", stderr: "" }; },
      async runBuffer() {
        return Buffer.from(`worktree ${fixture.root}\0HEAD ${fixture.initialOid}\0branch refs/tags/v1\0\0`);
      }
    };
    await expect(new GitReadService(git).listWorktrees(fixture.root)).rejects.toThrow("GIT_REF_INVALID");
  });
});
