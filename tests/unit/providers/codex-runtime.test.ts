import { describe, expect, it, vi } from "vitest";
import { createCodexRuntime } from "../../../src/provider-runner/codex-runtime";
import { codexRunCommand, createCodexSdkDouble } from "../../helpers/provider-sdk-doubles";

describe("Codex provider runtime", () => {
  it("uses only the external path, replacement env, and reviewed lock", async () => {
    const sdk = createCodexSdkDouble();
    const runtime = createCodexRuntime({ sdk, now: () => new Date("2026-07-21T10:00:00.000Z") });
    await runtime.start(codexRunCommand(), vi.fn());
    expect(sdk.create).toHaveBeenCalledWith({
      codexPathOverride: "/opt/homebrew/bin/codex", env: { HOME: "/Users/tester", PATH: "/opt/homebrew/bin:/usr/bin:/bin" },
      codexConfigLockRealpath: "/Applications/Branchestra.app/Contents/Resources/codex/0.144.6/subscription.config.lock.toml",
    });
    expect(sdk.startThread).toHaveBeenCalledWith({ workingDirectory: "/worktrees/task-1/collaborator", sandboxMode: "workspace-write", approvalPolicy: "never", networkAccessEnabled: false, webSearchMode: "disabled", webSearchEnabled: false, additionalDirectories: [] });
    expect(sdk.runStreamed).toHaveBeenCalledWith(expect.stringContaining("READ-ONLY BRANCHESTRA SNAPSHOT"), { signal: expect.any(AbortSignal) });
  });

  it("resumes the persisted thread and only enables shell network from the receipt", async () => {
    const sdk = createCodexSdkDouble();
    const runtime = createCodexRuntime({ sdk, now: () => new Date(), contextSnapshot: vi.fn(() => "snapshot") });
    await runtime.start(codexRunCommand({ providerSessionId: "thread-1", toolNetwork: true }), vi.fn());
    expect(sdk.resumeThread).toHaveBeenCalledWith("thread-1", expect.objectContaining({ networkAccessEnabled: true, webSearchMode: "disabled", webSearchEnabled: false }));
  });
});
