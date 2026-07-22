import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitCommandRunner, type GitCommandResult } from "../../src/worker/git/git-command-runner";
import type { WorkspaceGuardIdentity } from "../../src/worker/git/workspace-path-guard";

export interface GitRepositoryFixture {
  root: string;
  commonDirRealpath: string;
  initialOid: string;
  run(argv: readonly string[], cwd?: string): Promise<GitCommandResult>;
  write(relativePath: string, contents: string | Uint8Array): Promise<void>;
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
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

export async function createGitRepositoryFixture(): Promise<GitRepositoryFixture> {
  const root = await mkdtemp(join(tmpdir(), "branchestra git repository "));
  const git = new GitCommandRunner();
  try {
    await git.run(root, ["init", "-b", "main"]);
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
