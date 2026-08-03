import { realpath } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { execFileNoShell } from "../../../src/worker/process/exec-file";
import { probeProviderAuth } from "../../../src/worker/providers/auth-probes";
import { buildProviderEnvironment } from "../../../src/worker/providers/provider-environment";
import { loadClaudeSdkFactory, loadCodexSdkFactory } from "../../../src/provider-runner/sdk-factories";

const enabled = process.env.BRANCHESTRA_PRIVATE_PROVIDER_SMOKE === "1";
const claudePath = process.env.BRANCHESTRA_CLAUDE_PATH;
const codexPath = process.env.BRANCHESTRA_CODEX_PATH;
if (!enabled || !claudePath || !codexPath) {
  throw new Error("Private provider smoke requires explicit enablement and both external CLI paths");
}

describe("private real Provider smoke", () => {
  const setup = async () => {
    const [claude, codex] = await Promise.all([realpath(claudePath), realpath(codexPath)]);
    const host = { homeDirectory: process.env.HOME ?? "/", temporaryDirectory: process.env.TMPDIR ?? "/tmp", userName: process.env.USER ?? "user", approvedPathEntries: [] as string[], source: process.env };
    const claudeEnv = buildProviderEnvironment({ ...host, provider: "claude", executableRealpath: claude });
    const codexEnv = buildProviderEnvironment({ ...host, provider: "codex", executableRealpath: codex });
    return { claude, codex, claudeEnv, codexEnv };
  };

  it("uses canonical current-version external CLIs", async () => {
    const { claude, codex, claudeEnv, codexEnv } = await setup();
    const claudeVersion = await execFileNoShell(claude, ["--version"], { env: claudeEnv, timeoutMs: 5_000, maxBufferBytes: 65_536 });
    const codexVersion = await execFileNoShell(codex, ["--version"], { env: codexEnv, timeoutMs: 5_000, maxBufferBytes: 65_536 });
    expect(claudeVersion.stdout.trim()).toContain("2.1.220");
    expect(codexVersion.stdout.trim()).toContain("0.145.0");
  });

  it("probes Claude subscription auth", async () => {
    const { claude, claudeEnv } = await setup();
    const expectedState = process.env.BRANCHESTRA_EXPECT_CLAUDE_AUTH ?? "subscription";
    const decision = await probeProviderAuth({ provider: "claude", executableRealpath: claude, env: claudeEnv, runner: execFileNoShell });
    expect(decision.state, JSON.stringify(decision)).toBe(expectedState);
  });

  it("probes Codex ChatGPT auth through the reviewed lock", async () => {
    const { codex, codexEnv } = await setup();
    const lockPath = process.env.BRANCHESTRA_CODEX_CONFIG_LOCK_PATH;
    if (!lockPath) throw new Error("Private Codex smoke requires BRANCHESTRA_CODEX_CONFIG_LOCK_PATH");
    const canonicalLock = await realpath(lockPath);
    await expect(probeProviderAuth({ provider: "codex", executableRealpath: codex, codexConfigLockRealpath: canonicalLock, env: codexEnv, runner: execFileNoShell })).resolves.toEqual({ state: "subscription", display: "ChatGPT" });
  });

  it("runs a Claude Agent SDK turn with the current external CLI", async () => {
    const { claude, claudeEnv } = await setup();
    const sdk = await loadClaudeSdkFactory().load();
    const query = sdk.query({
      prompt: "Reply only OK.",
      options: {
        pathToClaudeCodeExecutable: claude,
        cwd: process.cwd(),
        env: claudeEnv,
        settingSources: [],
        allowedTools: [],
        disallowedTools: ["Agent", "Task", "Bash", "Edit", "Write", "WebFetch", "WebSearch"],
        maxTurns: 1,
        persistSession: false,
      },
    });
    const messageTypes: string[] = [];
    try {
      for await (const message of query) messageTypes.push((message as { type?: string }).type ?? "unknown");
    } finally {
      query.close();
    }
    expect(messageTypes).toContain("result");
  });

  it("runs a Codex SDK turn with the current external CLI", async () => {
    const { codex, codexEnv } = await setup();
    const lockPath = process.env.BRANCHESTRA_CODEX_CONFIG_LOCK_PATH;
    if (!lockPath) throw new Error("Private Codex smoke requires BRANCHESTRA_CODEX_CONFIG_LOCK_PATH");
    const sdk = await loadCodexSdkFactory();
    const client = sdk.create({ codexPathOverride: codex, env: codexEnv, codexConfigLockRealpath: await realpath(lockPath) });
    const thread = client.startThread({ workingDirectory: process.cwd(), sandboxMode: "read-only", approvalPolicy: "never", networkAccessEnabled: false, webSearchMode: "disabled" });
    const stream = await thread.runStreamed("Reply only OK.", { signal: AbortSignal.timeout(60_000) });
    const eventTypes: string[] = [];
    for await (const event of stream.events) eventTypes.push((event as { type?: string }).type ?? "unknown");
    expect(eventTypes).toContain("thread.started");
    expect(eventTypes).toContain("turn.completed");
  });
});
