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

  it.each(["a".repeat(41), "a".repeat(63)])("rejects a non-exact legacy HEAD OID length", async (headOid) => {
    const outputs = ["/canonical/repo\n", "/canonical/repo/.git\n", `${headOid}\n`, "main\n"];
    const execFile: ExecFileRunner = async () => ({ stdout: outputs.shift() ?? "", stderr: "" });
    await expect(inspectExistingRepository("/chosen", {
      execFile,
      realpath: async (path) => path,
      gitExecutable: "/usr/bin/git"
    })).rejects.toThrow(GitRepositoryError);
  });

});
