import { access, chmod, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { discoverExternalExecutable } from "../../../src/worker/providers/executable-discovery";

describe("external provider executable discovery", () => {
  it("returns the realpath and probes that exact executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "branchestra-cli-"));
    const executable = join(root, "claude-real");
    const selected = join(root, "claude");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);
    await symlink(executable, selected);
    const runner = vi.fn().mockResolvedValue({ stdout: "2.1.206\n", stderr: "" });
    const detected = await discoverExternalExecutable({ provider: "claude", selectedPath: selected, homeDirectory: root, architecture: "arm64", runner });
    expect(detected?.executableRealpath).toBe(await realpath(executable));
    expect(runner).toHaveBeenCalledWith(await realpath(executable), ["--version"], expect.objectContaining({ timeoutMs: 5_000, maxBufferBytes: 65_536 }));
    await access(detected!.executableRealpath);
  });

  it("does not consult PATH or accept a non-executable file", async () => {
    const root = await mkdtemp(join(tmpdir(), "branchestra-cli-"));
    const selected = join(root, "codex");
    await writeFile(selected, "not executable", "utf8");
    const runner = vi.fn();
    const detected = await discoverExternalExecutable({ provider: "codex", selectedPath: selected, homeDirectory: root, architecture: "x64", runner });
    expect(detected).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });
});
