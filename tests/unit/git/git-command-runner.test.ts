import { execFile as nodeExecFile } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { GitCommandRunner } from "../../../src/worker/git/git-command-runner";

describe("GitCommandRunner", () => {
  it("always uses execFile argv, shell false, controlled env, app identity, and disabled hooks", async () => {
    const execFile = vi.fn((_file, _argv, _options, callback) => {
      callback(null, "abc\n", "");
      return undefined;
    }) as unknown as typeof nodeExecFile;
    const runner = new GitCommandRunner({ execFile, executableRealpath: "/usr/bin/git" });

    await expect(runner.run("/repo with spaces", ["rev-parse", "HEAD"])).resolves.toEqual({
      stdout: "abc\n",
      stderr: ""
    });

    expect(execFile).toHaveBeenCalledWith("/usr/bin/git", [
      "-c", "user.name=Branchestra",
      "-c", "user.email=branchestra@localhost",
      "-c", "core.hooksPath=/dev/null",
      "-C", "/repo with spaces", "rev-parse", "HEAD"
    ], {
      shell: false,
      env: {
        PATH: "/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null"
      },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024
    }, expect.any(Function));
  });

  it("uses the bounded buffer execution path without decoding stdout", async () => {
    const stdout = Buffer.from([0, 255, 1, 2]);
    const execFile = vi.fn((_file, _argv, _options, callback) => {
      callback(null, stdout, Buffer.alloc(0));
      return undefined;
    }) as unknown as typeof nodeExecFile;
    const runner = new GitCommandRunner({ execFile });

    await expect(runner.runBuffer("/repo", ["show", "HEAD"])).resolves.toBe(stdout);
    expect(execFile).toHaveBeenCalledWith("/usr/bin/git", expect.any(Array), expect.objectContaining({
      shell: false,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024
    }), expect.any(Function));
  });
});
