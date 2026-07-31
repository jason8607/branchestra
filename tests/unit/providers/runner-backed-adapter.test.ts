import { describe, expect, it, vi } from "vitest";
import { RunnerBackedAdapter } from "../../../src/worker/providers/runner-backed-adapter";

const request = {
  runId: "019f842d-e19a-7cc1-9d73-4d287bf40558", taskId: "task-1", provider: "codex" as const,
  role: "lead" as const, worktreePath: "/tmp/worktree", instruction: "implement", contextVersion: 1,
  contextHash: "a".repeat(64), checkpointOid: null,
  approvedCapabilities: { workspaceRootRealpath: "/tmp/worktree", readableRootsRealpath: ["/tmp/worktree"], commandClasses: ["test" as const], toolNetwork: false, allowCollaborator: true, maxRunMs: 10_000 },
};

describe("RunnerBackedAdapter", () => {
  it("requires ready health, sends a strict runner command, and streams normalized events", async () => {
    let deliver: ((message: unknown) => Promise<void>) | undefined;
    const send = vi.fn();
    const adapter = new RunnerBackedAdapter({
      provider: "codex", capabilities: { interactiveApproval: false, protocolInterrupt: false, processAbort: true, textDeltaStreaming: false, itemEventStreaming: true, sessionResume: true, workspaceWriteSandbox: true, toolNetworkControl: true, contextTools: "injected" },
      health: { list: async () => [{ provider: "codex", state: "ready", executableRealpath: "/opt/homebrew/bin/codex", cliVersion: "0.144.6", sdkVersion: "0.144.6", architecture: "arm64", authLabel: "Subscription-only", capabilities: null, repairAction: null }] },
      codexConfigLockRealpath: async () => "/app/subscription.config.lock.toml",
      runner: { launch: async (_input, accept) => { deliver = accept; return { send, cancel: vi.fn() }; } },
      normalize: (_raw, run) => [{ ...run, provider: "codex", type: "run.completed", result: "done" }],
      now: () => "2026-07-21T10:00:00.000Z",
    });
    const handle = await adapter.startRun(request);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "run.start", executableRealpath: "/opt/homebrew/bin/codex", codexConfigLockRealpath: "/app/subscription.config.lock.toml" }));
    await deliver!({ type: "provider.raw", runId: request.runId, providerSeq: 0, receivedAt: "2026-07-21T10:00:00.000Z", payload: {} });
    const event = await handle.events[Symbol.asyncIterator]().next();
    expect(event.value).toEqual({ type: "run.completed", summary: "done" });
    await expect(handle.completion).resolves.toEqual({ outcome: "completed", summary: "done", error: null });
  });

  it("fails closed when health is not ready", async () => {
    const adapter = new RunnerBackedAdapter({
      provider: "codex", capabilities: {} as never,
      health: { list: async () => [{ provider: "codex", state: "policy_disabled", executableRealpath: "/opt/homebrew/bin/codex", cliVersion: "0.144.6", sdkVersion: "0.144.6", architecture: "arm64", authLabel: "Subscription-only", capabilities: null, repairAction: "evidence required" }] },
      codexConfigLockRealpath: async () => "/app/lock", runner: { launch: vi.fn() }, normalize: vi.fn(), now: () => new Date().toISOString(),
    });
    await expect(adapter.startRun(request)).rejects.toThrow("PROVIDER_NOT_READY:codex:policy_disabled");
  });
});
