import { describe, expect, it, vi } from "vitest";
import { probeProviderAuth } from "../../../src/worker/providers/auth-probes";

describe("provider auth probes", () => {
  it("accepts explicit Claude subscription status from the same executable", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }), stderr: "" });
    await expect(probeProviderAuth({ provider: "claude", executableRealpath: "/real/claude", env: { HOME: "/Users/tester" }, runner }))
      .resolves.toEqual({ state: "subscription", display: "Claude Max" });
    expect(runner).toHaveBeenCalledWith("/real/claude", ["auth", "status", "--json"], expect.objectContaining({ timeoutMs: 5_000, maxBufferBytes: 65_536 }));
  });

  it("accepts the current Claude subscription status without a plan label", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }), stderr: "" });
    await expect(probeProviderAuth({ provider: "claude", executableRealpath: "/real/claude", env: {}, runner }))
      .resolves.toEqual({ state: "subscription", display: "Claude" });

    const unknownPlanRunner = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "unknown" }), stderr: "" });
    await expect(probeProviderAuth({ provider: "claude", executableRealpath: "/real/claude", env: {}, runner: unknownPlanRunner }))
      .resolves.toEqual({ state: "subscription", display: "Claude" });
  });

  it.each([
    [{ loggedIn: true, authMethod: "api_key" }, "api_key"],
    [{ loggedIn: true, authMethod: "bedrock" }, "bedrock"],
    [{ loggedIn: true, authMethod: "vertex" }, "vertex"],
    [{ loggedIn: true, authMethod: "foundry" }, "foundry"],
  ])("blocks Claude non-subscription auth %#", async (payload, mode) => {
    const runner = vi.fn().mockResolvedValue({ stdout: JSON.stringify(payload), stderr: "" });
    await expect(probeProviderAuth({ provider: "claude", executableRealpath: "/real/claude", env: {}, runner }))
      .resolves.toEqual({ state: "blocked", reason: `Unsupported Claude auth mode: ${mode}` });
  });

  it("recognizes the current Claude signed-out status", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }), stderr: "" });
    await expect(probeProviderAuth({ provider: "claude", executableRealpath: "/real/claude", env: {}, runner }))
      .resolves.toEqual({ state: "signed_out", reason: "claude is not logged in" });

    const staleSessionRunner = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ loggedIn: false, authMethod: "claude.ai", apiProvider: "firstParty" }), stderr: "" });
    await expect(probeProviderAuth({ provider: "claude", executableRealpath: "/real/claude", env: {}, runner: staleSessionRunner }))
      .resolves.toEqual({ state: "signed_out", reason: "claude is not logged in" });
  });

  it("accepts only the exact Codex ChatGPT status", async () => {
    const readyRunner = vi.fn().mockResolvedValue({ stdout: "Logged in using ChatGPT\n", stderr: "" });
    await expect(probeProviderAuth({ provider: "codex", executableRealpath: "/real/codex", codexConfigLockRealpath: "/app/subscription.config.lock.toml", env: {}, runner: readyRunner }))
      .resolves.toEqual({ state: "subscription", display: "ChatGPT" });
    expect(readyRunner).toHaveBeenCalledWith("/real/codex", [
      "login", "status", "--config", "debug.config_lockfile.load_path=\"/app/subscription.config.lock.toml\"",
      "--config", "debug.config_lockfile.allow_codex_version_mismatch=false",
    ], expect.objectContaining({ timeoutMs: 5_000, maxBufferBytes: 65_536 }));

    const keyRunner = vi.fn().mockResolvedValue({ stdout: "Logged in using an API key\n", stderr: "" });
    await expect(probeProviderAuth({ provider: "codex", executableRealpath: "/real/codex", codexConfigLockRealpath: "/app/subscription.config.lock.toml", env: {}, runner: keyRunner }))
      .resolves.toEqual({ state: "blocked", reason: "Unsupported Codex auth mode: api_key" });

    const currentRunner = vi.fn().mockResolvedValue({ stdout: "", stderr: "Logged in using ChatGPT\n" });
    await expect(probeProviderAuth({ provider: "codex", executableRealpath: "/real/codex", codexConfigLockRealpath: "/app/subscription.config.lock.toml", env: {}, runner: currentRunner }))
      .resolves.toEqual({ state: "subscription", display: "ChatGPT" });
  });

  it("blocks unknown output without reading auth storage", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: "Signed in somehow\n", stderr: "" });
    await expect(probeProviderAuth({ provider: "codex", executableRealpath: "/real/codex", codexConfigLockRealpath: "/app/lock.toml", env: {}, runner }))
      .resolves.toEqual({ state: "unknown", reason: "Unrecognized Codex auth status" });
  });
});
