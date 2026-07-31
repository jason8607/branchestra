import { expect, it } from "vitest";
import { verifyPolicy } from "../../../scripts/verify-release-policy.mjs";

it("blocks public Claude subscription support without approved written evidence", () => {
  expect(() => verifyPolicy({
    schemaVersion: 1, publicFeatures: { claudeSubscription: true, codexSubscription: false },
    providers: {
      claude: { status: "blocked", sdkVersion: "0.3.216", cliVersion: "2.1.206", reviewedAt: "2026-07-21", sourceUrl: "https://code.claude.com/docs/en/legal-and-compliance", policyEvidence: null, enforcementReports: [] },
      codex: { status: "pending_evidence", sdkVersion: "0.144.6", cliVersion: "0.144.6", reviewedAt: "2026-07-21", sourceUrl: "https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan", policyEvidence: null, enforcementReports: [] },
    },
  }, new Date("2026-07-21T00:00:00Z"))).toThrow("claudeSubscription cannot be enabled");
});
