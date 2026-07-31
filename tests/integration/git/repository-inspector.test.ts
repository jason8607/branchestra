import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function snapshotObjectDatabase(objectsPath: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else {
        const bytes = await readFile(path);
        files.push(`${relative(objectsPath, path)}:${bytes.length}:${createHash("sha256").update(bytes).digest("hex")}`);
      }
    }
  }
  await visit(objectsPath);
  return files.sort();
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

  it("rejects a selected repository whose observed top-level differs from the stored root", async () => {
    const stored = await makeFixture();
    const selected = await makeFixture();
    const service = new GitReadService(new GitCommandRunner());
    await expect(service.inspectRepository(selected.root, stored.root)).rejects.toThrow("REPOSITORY_IDENTITY_MISMATCH");
  });

  it("rejects a valid Git branch outside the supported product subset during inspection", async () => {
    const fixture = await makeFixture();
    await fixture.run(["branch", "-m", "日本語"]);

    await expect(new GitReadService(new GitCommandRunner()).inspectRepository(fixture.root))
      .rejects.toThrow("GIT_REF_UNSUPPORTED");
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

  it("rejects status when the worktree belongs to another repository", async () => {
    const repository = await makeFixture();
    const otherRepository = await makeFixture();
    const service = new GitReadService(new GitCommandRunner());
    await expect(service.status({
      repositoryRootRealpath: repository.root,
      worktreePathRealpath: otherRepository.root
    })).rejects.toThrow("REPOSITORY_IDENTITY_MISMATCH");
  });

  it("does not execute configured fsmonitor, external-diff, or textconv helpers", async () => {
    const fixture = await makeFixture();
    const sentinel = join(fixture.root, "HELPER_EXECUTED");
    const helper = join(fixture.root, "configured helper.sh");
    const quotedSentinel = sentinel.replaceAll("'", "'\\''");
    const quotedHelper = `'${helper.replaceAll("'", "'\\''")}'`;
    await writeFile(helper, `#!/bin/sh\n/usr/bin/touch '${quotedSentinel}'\nexit 0\n`);
    await chmod(helper, 0o755);
    await fixture.run(["config", "core.fsmonitor", quotedHelper]);
    await fixture.run(["config", "diff.external", quotedHelper]);
    await fixture.run(["config", "diff.sentinel.textconv", quotedHelper]);
    await fixture.write(".gitattributes", "README.md diff=sentinel\n");
    await fixture.write("README.md", "changed\n");
    const service = new GitReadService(new GitCommandRunner());

    await service.status({ repositoryRootRealpath: fixture.root, worktreePathRealpath: fixture.root });
    await service.diff({ repositoryRootRealpath: fixture.root, fromOid: fixture.initialOid });
    await service.show({ repositoryRootRealpath: fixture.root, oid: fixture.initialOid, path: "README.md" });
    await service.log({ repositoryRootRealpath: fixture.root, startOid: fixture.initialOid, maxCount: 1 });

    expect(await pathExists(sentinel)).toBe(false);
  });

  it("does not mutate or lock the index during status", async () => {
    const fixture = await makeFixture();
    const indexPath = join(fixture.commonDirRealpath, "index");
    await fixture.write("README.md", "working tree change\n");
    const beforeBytes = await readFile(indexPath);
    const beforeStat = await stat(indexPath, { bigint: true });

    await new GitReadService(new GitCommandRunner()).status({
      repositoryRootRealpath: fixture.root,
      worktreePathRealpath: fixture.root
    });

    expect(await readFile(indexPath)).toEqual(beforeBytes);
    expect((await stat(indexPath, { bigint: true })).mtimeNs).toBe(beforeStat.mtimeNs);
    expect(await pathExists(`${indexPath}.lock`)).toBe(false);
  });

  it("does not contact a promisor remote or mutate the object database for a missing object", async () => {
    const source = await makeFixture();
    await source.run(["config", "uploadpack.allowFilter", "true"]);
    const parent = await mkdtemp(join(tmpdir(), "branchestra-partial-"));
    extraRoots.push(parent);
    const clone = join(parent, "partial");
    execFileSync("/usr/bin/git", [
      "-c", "protocol.file.allow=always",
      "-C", parent,
      "clone", "--no-local", "--no-checkout", "--filter=blob:none", `file://${source.root}`, clone
    ], {
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }
    });
    const blobOid = (await source.run(["rev-parse", `${source.initialOid}:README.md`])).stdout.trim();
    expect(() => execFileSync("/usr/bin/git", [
      "-c", "protocol.allow=never", "-C", clone, "cat-file", "-e", blobOid
    ])).toThrow();

    const sentinel = join(parent, "PROMISOR_CONTACTED");
    const uploadPack = join(parent, "upload-pack-sentinel.sh");
    const quotedSentinel = sentinel.replaceAll("'", "'\\''");
    const quotedSource = source.root.replaceAll("'", "'\\''");
    await writeFile(uploadPack, [
      "#!/bin/sh",
      `/usr/bin/touch '${quotedSentinel}'`,
      `exec /usr/bin/git-upload-pack '${quotedSource}'`,
      ""
    ].join("\n"));
    await chmod(uploadPack, 0o755);
    await new GitCommandRunner().run(clone, ["remote", "set-url", "origin", `ext::${uploadPack}`]);
    await new GitCommandRunner().run(clone, ["config", "protocol.ext.allow", "always"]);
    const objectsPath = join(clone, ".git", "objects");
    const before = await snapshotObjectDatabase(objectsPath);

    let failed = false;
    try {
      await new GitReadService(new GitCommandRunner()).show({
        repositoryRootRealpath: clone,
        oid: source.initialOid,
        path: "README.md"
      });
    } catch {
      failed = true;
    }

    expect({
      failed,
      contacted: await pathExists(sentinel),
      objectDatabase: await snapshotObjectDatabase(objectsPath)
    }).toEqual({
      failed: true,
      contacted: false,
      objectDatabase: before
    });
  });

  it("binds show, diff, and log content to supplied OIDs despite replacement refs", async () => {
    const fixture = await makeFixture();
    await fixture.write("README.md", "original head\n");
    await fixture.run(["add", "--", "README.md"]);
    await fixture.run(["commit", "--no-gpg-sign", "-m", "Original head"]);
    const originalHead = (await fixture.run(["rev-parse", "HEAD"])).stdout.trim();

    await fixture.run(["switch", "--orphan", "replacement-root"]);
    await fixture.write("README.md", "replacement content\n");
    await fixture.run(["add", "-A"]);
    await fixture.run(["commit", "--no-gpg-sign", "-m", "Replacement subject"]);
    const replacementOid = (await fixture.run(["rev-parse", "HEAD"])).stdout.trim();
    await fixture.run(["switch", "main"]);
    await fixture.run(["replace", fixture.initialOid, replacementOid]);

    const service = new GitReadService(new GitCommandRunner());
    const shown = await service.show({
      repositoryRootRealpath: fixture.root,
      oid: fixture.initialOid,
      path: "README.md"
    });
    const diff = await service.diff({
      repositoryRootRealpath: fixture.root,
      fromOid: fixture.initialOid,
      toOid: originalHead
    });
    const log = await service.log({
      repositoryRootRealpath: fixture.root,
      startOid: fixture.initialOid,
      maxCount: 1
    });

    expect(shown).toContain("+# Fixture");
    expect(shown).not.toContain("replacement content");
    expect(diff.patch).toContain("-# Fixture");
    expect(diff.patch).toContain("+original head");
    expect(diff.patch).not.toContain("replacement content");
    expect(log).toMatchObject([{ oid: fixture.initialOid, subject: "Initial commit" }]);
  });

  it("rejects invalid UTF-8 path bytes instead of returning replacement characters", async () => {
    const fixture = await makeFixture();
    const output = Buffer.concat([
      Buffer.from(`worktree ${fixture.root}/invalid-`),
      Buffer.from([0xff]),
      Buffer.from(`\0HEAD ${fixture.initialOid}\0branch refs/heads/main\0\0`)
    ]);
    const git = {
      async run() { return { stdout: "", stderr: "" }; },
      async runBuffer() { return output; }
    };
    await expect(new GitReadService(git).listWorktrees(fixture.root)).rejects.toThrow("GIT_OUTPUT_INVALID_UTF8");
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

  it("preserves record and field separator bytes in a real commit subject", async () => {
    const fixture = await makeFixture();
    const subject = `control-${String.fromCharCode(0x1e)}-and-${String.fromCharCode(0x1f)}-bytes`;
    await fixture.write("control.txt", "control\n");
    await fixture.run(["add", "--", "control.txt"]);
    await fixture.run(["commit", "--no-gpg-sign", "-m", subject]);
    const head = (await fixture.run(["rev-parse", "HEAD"])).stdout.trim();

    const entries = await new GitReadService(new GitCommandRunner()).log({
      repositoryRootRealpath: fixture.root,
      startOid: head,
      maxCount: 1
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.subject).toBe(subject);
  });

  it("rejects log metadata with a syntactically shaped but impossible authored date", async () => {
    const oid = "a".repeat(40);
    let call = 0;
    const git = {
      async run() { return { stdout: "", stderr: "" }; },
      async runBuffer() {
        call += 1;
        return call === 1
          ? Buffer.from(`${oid}\0`)
          : Buffer.from(`${oid}\n\n2026-99-99T99:99:99+99:99\nsubject\n`);
      }
    };
    await expect(new GitReadService(git).log({
      repositoryRootRealpath: "/repo",
      startOid: oid,
      maxCount: 1
    })).rejects.toThrow("GIT_OUTPUT_INVALID");
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
      async runBuffer(_cwd: string, argv: readonly string[]) {
        (calls as string[][]).push([...argv]);
        return Buffer.alloc(0);
      }
    };
    const service = new GitReadService(git);
    await service.show({ repositoryRootRealpath: "/repo", oid: "a".repeat(40) });
    await service.show({ repositoryRootRealpath: "/repo", oid: "b".repeat(64) });
    expect(calls).toEqual([
      ["show", "--no-ext-diff", "--no-textconv", "a".repeat(40)],
      ["show", "--no-ext-diff", "--no-textconv", "b".repeat(64)]
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

  it("rejects a worktree on a valid Git branch outside the supported product subset", async () => {
    const fixture = await makeFixture();
    const linked = join(fixture.root, "unsupported branch worktree");
    await fixture.run(["worktree", "add", "-b", "日本語", linked]);

    await expect(new GitReadService(new GitCommandRunner()).listWorktrees(fixture.root))
      .rejects.toThrow("GIT_REF_UNSUPPORTED");
  });

  it("times out and kills a Git-configured executable alias", async () => {
    const fixture = await makeFixture();
    const runner = new GitCommandRunner({ timeoutMs: 50 });
    const startedAt = Date.now();
    await expect(runner.run(fixture.root, [
      "-c", "alias.hang=!/bin/sleep 10", "hang"
    ])).rejects.toMatchObject({ killed: true });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
