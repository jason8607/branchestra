import { describe, expect, it } from "vitest";
import { inspectExistingRepository } from "../../src/worker/git/inspect-repository";
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
});
