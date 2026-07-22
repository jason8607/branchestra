import { describe, expect, it } from "vitest";
import {
  GitRepositoryError,
  inspectExistingRepository
} from "../../src/worker/git/inspect-repository";
import type { ExecFileRunner } from "../../src/worker/process/exec-file";

describe("inspectExistingRepository", () => {
  it("canonicalizes root/common dir and invokes absolute Git with argv", async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const outputs = ["/canonical/repo\n", "/canonical/repo/.git\n", `${"a".repeat(40)}\n`, "main\n"];
    const execFile: ExecFileRunner = async (executable, args) => {
      calls.push({ executable, args });
      return { stdout: outputs.shift() ?? "", stderr: "" };
    };
    const result = await inspectExistingRepository("/chosen/subdir", {
      execFile,
      realpath: async (path) => path === "/chosen/subdir" ? "/canonical/chosen" : path,
      gitExecutable: "/usr/bin/git"
    });
    expect(result).toEqual({ repositoryRoot: "/canonical/repo", gitCommonDir: "/canonical/repo/.git", headOid: "a".repeat(40), defaultBranch: "main" });
    expect(calls).toEqual([
      { executable: "/usr/bin/git", args: ["-C", "/canonical/chosen", "rev-parse", "--path-format=absolute", "--show-toplevel"] },
      { executable: "/usr/bin/git", args: ["-C", "/canonical/repo", "rev-parse", "--path-format=absolute", "--git-common-dir"] },
      { executable: "/usr/bin/git", args: ["-C", "/canonical/repo", "rev-parse", "--verify", "HEAD^{commit}"] },
      { executable: "/usr/bin/git", args: ["-C", "/canonical/repo", "rev-parse", "--abbrev-ref", "HEAD"] }
    ]);
  });

  it("removes one Git line terminator without changing path spaces", async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const realpathCalls: string[] = [];
    const outputs = ["/canonical/repo \r\n", "/canonical/repo /.git \n", `${"a".repeat(40)}\n`, "main\n"];
    const execFile: ExecFileRunner = async (executable, args) => {
      calls.push({ executable, args });
      return { stdout: outputs.shift() ?? "", stderr: "" };
    };

    const result = await inspectExistingRepository("/chosen/subdir", {
      execFile,
      realpath: async (path) => {
        realpathCalls.push(path);
        return path === "/chosen/subdir" ? "/canonical/chosen" : path;
      },
      gitExecutable: "/usr/bin/git"
    });

    expect(result).toEqual({ repositoryRoot: "/canonical/repo ", gitCommonDir: "/canonical/repo /.git ", headOid: "a".repeat(40), defaultBranch: "main" });
    expect(realpathCalls).toEqual(["/chosen/subdir", "/canonical/repo ", "/canonical/repo /.git "]);
    expect(calls).toEqual([
      { executable: "/usr/bin/git", args: ["-C", "/canonical/chosen", "rev-parse", "--path-format=absolute", "--show-toplevel"] },
      { executable: "/usr/bin/git", args: ["-C", "/canonical/repo ", "rev-parse", "--path-format=absolute", "--git-common-dir"] },
      { executable: "/usr/bin/git", args: ["-C", "/canonical/repo ", "rev-parse", "--verify", "HEAD^{commit}"] },
      { executable: "/usr/bin/git", args: ["-C", "/canonical/repo ", "rev-parse", "--abbrev-ref", "HEAD"] }
    ]);
  });

  it("reports detached HEAD as a null branch", async () => {
    const outputs = ["/canonical/repo\n", "/canonical/repo/.git\n", `${"b".repeat(40)}\n`, "HEAD\n"];
    const execFile: ExecFileRunner = async () => ({ stdout: outputs.shift() ?? "", stderr: "" });

    await expect(inspectExistingRepository("/chosen", {
      execFile,
      realpath: async (path) => path,
      gitExecutable: "/usr/bin/git"
    })).resolves.toEqual({
      repositoryRoot: "/canonical/repo",
      gitCommonDir: "/canonical/repo/.git",
      headOid: "b".repeat(40),
      defaultBranch: null
    });
  });

  it("wraps Git failures while preserving the underlying stderr cause", async () => {
    const failure = Object.assign(new Error("git exited 128"), { stderr: "fatal: not a git repository\n" });
    const execFile: ExecFileRunner = async () => {
      throw failure;
    };

    let thrown: unknown;
    try {
      await inspectExistingRepository("/chosen", {
        execFile,
        realpath: async (path) => path,
        gitExecutable: "/usr/bin/git"
      });
    } catch (error) {
      thrown = error;
    }

    const gitError = thrown as Error & { cause: typeof failure };
    expect(thrown).toBeInstanceOf(GitRepositoryError);
    expect(gitError.cause).toBe(failure);
    expect(gitError.cause.stderr).toBe("fatal: not a git repository\n");
  });

  it("canonicalizes a linked worktree's symlinked common directory with argv-only Git", async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const outputs = [
      "/reported/worktree-root\n",
      "/reported/gitdir-link/worktrees/feature\n",
      `${"c".repeat(40)}\n`,
      "feature\n"
    ];
    const execFile: ExecFileRunner = async (executable, args) => {
      calls.push({ executable, args });
      return { stdout: outputs.shift() ?? "", stderr: "" };
    };
    const canonicalPaths: Record<string, string> = {
      "/chosen/worktree-symlink": "/canonical/worktree",
      "/reported/worktree-root": "/canonical/worktree-root",
      "/reported/gitdir-link/worktrees/feature": "/canonical/main.git/worktrees/feature"
    };

    const result = await inspectExistingRepository("/chosen/worktree-symlink", {
      execFile,
      realpath: async (path) => canonicalPaths[path] ?? path,
      gitExecutable: "/usr/bin/git"
    });

    expect(result).toEqual({
      repositoryRoot: "/canonical/worktree-root",
      gitCommonDir: "/canonical/main.git/worktrees/feature",
      headOid: "c".repeat(40),
      defaultBranch: "feature"
    });
    expect(calls).toEqual([
      { executable: "/usr/bin/git", args: ["-C", "/canonical/worktree", "rev-parse", "--path-format=absolute", "--show-toplevel"] },
      { executable: "/usr/bin/git", args: ["-C", "/canonical/worktree-root", "rev-parse", "--path-format=absolute", "--git-common-dir"] },
      { executable: "/usr/bin/git", args: ["-C", "/canonical/worktree-root", "rev-parse", "--verify", "HEAD^{commit}"] },
      { executable: "/usr/bin/git", args: ["-C", "/canonical/worktree-root", "rev-parse", "--abbrev-ref", "HEAD"] }
    ]);
  });
});
