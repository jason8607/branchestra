import { describe, expect, it } from "vitest";
import { createProviderRegistry } from "../../../src/worker/providers/provider-registry";

describe("production provider registry", () => {
  it("fails closed for providers without public release evidence", () => {
    const registry = createProviderRegistry();
    expect(() => registry.requireRunnable("claude")).toThrow("Claude subscription runs are disabled by public release policy");
    expect(() => registry.requireRunnable("codex")).toThrow("Codex subscription runs are disabled by public release policy");
  });

  it("registers injected adapters only when the explicit test policy enables them", () => {
    const claude = { provider: "claude" as const };
    const codex = { provider: "codex" as const };
    const registry = createProviderRegistry({
      policy: { claudeSubscription: { enabled: true }, codexSubscription: { enabled: true } },
      createClaudeAdapter: () => claude as never,
      createCodexAdapter: () => codex as never,
    });
    expect(registry.requireRunnable("claude")).toBe(claude);
    expect(registry.requireRunnable("codex")).toBe(codex);
  });
});
