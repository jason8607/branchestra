import { describe, expect, it } from "vitest";
import { createProviderTestHarness } from "../../helpers/provider-test-harness";

describe("ProviderHealthService", () => {
  it("stores health metadata but no auth material and fails closed without release evidence", async () => {
    const harness = await createProviderTestHarness({ provider: "codex", versionOutput: "codex-cli 0.144.6\n", authOutput: "Logged in using ChatGPT\n" });
    const health = await harness.service.selectExecutable("codex", harness.executablePath);
    expect(health.state).toBe("policy_disabled");
    expect(health.repairAction).toContain("enforcement evidence");
    expect(health.authLabel).toBe("Subscription-only");
    const row = harness.db.prepare("SELECT * FROM provider_installations WHERE provider = ?").get("codex") as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(["architecture", "checked_at", "cli_version", "executable_realpath", "provider", "state"]);
    harness.db.close();
  });

  it("reports a technically healthy Claude CLI as public-policy disabled", async () => {
    const harness = await createProviderTestHarness({ provider: "claude", versionOutput: "2.1.206\n", authOutput: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }) });
    const health = await harness.service.selectExecutable("claude", harness.executablePath);
    expect(health.state).toBe("policy_disabled");
    expect(health.repairAction).toContain("written Anthropic approval");
    harness.db.close();
  });

  it("permits an exact-version authenticated Claude CLI in a private-local build", async () => {
    const harness = await createProviderTestHarness({
      provider: "claude",
      versionOutput: "2.1.206\n",
      authOutput: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      privateLocalProviders: true,
    });
    const health = await harness.service.selectExecutable("claude", harness.executablePath);
    expect(health.state).toBe("ready");
    expect(health.capabilities).not.toBeNull();
    harness.db.close();
  });
});
