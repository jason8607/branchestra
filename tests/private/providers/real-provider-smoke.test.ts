import { realpath } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { execFileNoShell } from "../../../src/worker/process/exec-file";
import { probeProviderAuth } from "../../../src/worker/providers/auth-probes";
import { buildProviderEnvironment } from "../../../src/worker/providers/provider-environment";

const enabled = process.env.BRANCHESTRA_PRIVATE_PROVIDER_SMOKE === "1";
const claudePath = process.env.BRANCHESTRA_CLAUDE_PATH;
const codexPath = process.env.BRANCHESTRA_CODEX_PATH;
if (!enabled || !claudePath || !codexPath) {
  throw new Error("Private provider smoke requires explicit enablement and both external CLI paths");
}

describe("private real Provider smoke", () => {
  it("uses canonical exact-version external CLIs with subscription auth", async () => {
    const [claude, codex] = await Promise.all([realpath(claudePath), realpath(codexPath)]);
    const host = { homeDirectory: process.env.HOME ?? "/", temporaryDirectory: process.env.TMPDIR ?? "/tmp", userName: process.env.USER ?? "user", approvedPathEntries: [] as string[], source: process.env };
    const claudeEnv = buildProviderEnvironment({ ...host, provider: "claude", executableRealpath: claude });
    const codexEnv = buildProviderEnvironment({ ...host, provider: "codex", executableRealpath: codex });
    const claudeVersion = await execFileNoShell(claude, ["--version"], { env: claudeEnv, timeoutMs: 5_000, maxBufferBytes: 65_536 });
    const codexVersion = await execFileNoShell(codex, ["--version"], { env: codexEnv, timeoutMs: 5_000, maxBufferBytes: 65_536 });
    expect(claudeVersion.stdout.trim()).toContain("2.1.206");
    expect(codexVersion.stdout.trim()).toContain("0.144.6");
    await expect(probeProviderAuth({ provider: "claude", executableRealpath: claude, env: claudeEnv, runner: execFileNoShell })).resolves.toMatchObject({ state: "subscription" });
    const lockPath = process.env.BRANCHESTRA_CODEX_CONFIG_LOCK_PATH;
    if (!lockPath) throw new Error("Private Codex smoke requires BRANCHESTRA_CODEX_CONFIG_LOCK_PATH");
    await expect(probeProviderAuth({ provider: "codex", executableRealpath: codex, codexConfigLockRealpath: await realpath(lockPath), env: codexEnv, runner: execFileNoShell })).resolves.toMatchObject({ state: "subscription" });
  });
});
