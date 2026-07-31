import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCodexRuntime } from "../../../src/provider-runner/codex-runtime";
import { loadCodexSdkFactory } from "../../../src/provider-runner/sdk-factories";
import { codexRunCommand } from "../../helpers/provider-sdk-doubles";

describe("Codex SDK config isolation", () => {
  it("uses the reviewed lock override through the real SDK spawn path", async () => {
    const root = await mkdtemp(join(tmpdir(), "branchestra-codex-isolation-"));
    const home = join(root, "home");
    const worktree = join(root, "worktree");
    const capture = join(root, "argv.json");
    const lock = join(root, "subscription.config.lock.toml");
    await mkdir(join(home, ".codex"), { recursive: true });
    await mkdir(join(worktree, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "config.toml"), 'model_provider="canary-home"\n');
    await writeFile(join(worktree, ".codex", "config.toml"), 'model_provider="canary-project"\n');
    await writeFile(lock, 'version = 1\ncodex_version = "0.144.6"\n');
    const executable = resolve("tests/fixtures/providers/codex/codex-cli-fixture.mjs");
    await chmod(executable, 0o755);
    const command = codexRunCommand();
    command.executableRealpath = executable;
    command.codexConfigLockRealpath = lock;
    command.request.worktreePath = worktree;
    command.request.approvedCapabilities.workspaceRootRealpath = worktree;
    command.request.environment = { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, BRANCHESTRA_CODEX_ARGV_CAPTURE: capture };
    const runtime = createCodexRuntime({ sdk: await loadCodexSdkFactory(), now: () => new Date("2026-07-21T10:00:00.000Z") });
    await runtime.start(command, vi.fn());
    const observed = JSON.parse(await readFile(capture, "utf8")) as { argv: string[]; envNames: string[] };
    const joined = observed.argv.join(" ");
    expect(joined).toContain(`debug.config_lockfile.load_path="${lock}"`);
    expect(joined).toContain("debug.config_lockfile.allow_codex_version_mismatch=false");
    expect(joined).not.toContain("canary-home");
    expect(joined).not.toContain("canary-project");
    expect(observed.envNames).not.toContain("OPENAI_API_KEY");
  });
});
