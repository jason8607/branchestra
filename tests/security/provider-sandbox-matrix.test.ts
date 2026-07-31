import { describe, expect, it } from "vitest";
import { decideProviderSupport, type EnforcementProfile } from "../../src/worker/security/enforcement-profile";
import { runEnforcementProbe } from "../../src/worker/security/enforcement-probe";

for (const provider of ["claude", "codex"] as const) {
  describe(`${provider} enforcement profile`, () => {
    const profile = (toolNetwork: boolean): EnforcementProfile => ({
      schemaVersion: 1, provider, sdkVersion: provider === "claude" ? "0.3.216" : "0.144.6",
      cliVersion: provider === "claude" ? "2.1.206" : "0.144.6", architecture: "arm64",
      writableRoots: ["/tmp/project/worktree"], readableRoots: ["/tmp/project"], gitCommonDir: "/tmp/project/.git",
      toolNetwork, environmentKeys: ["HOME", "PATH"],
    });
    it.each([false, true])("requires every negative capability result (network=%s)", async (toolNetwork) => {
      const report = await runEnforcementProbe(profile(toolNetwork), { nonce: () => "fixed", attempt: async (attempt) => attempt.expected });
      expect(decideProviderSupport(report)).toEqual({ supported: true });
      expect(report.results).toHaveLength(8);
    });
  });
}
