import { describe, expect, it } from "vitest";
import { resolveEffectiveProviderPolicy } from "../../../src/shared/config/effective-provider-policy";

const disabledPublicPolicy = {
  claudeSubscription: { enabled: false, writtenApproval: null },
  codexSubscription: { enabled: false, policyStatus: "pending_evidence" },
} as const;

describe("effective Provider policy", () => {
  it("keeps public builds bound to the checked-in public policy", () => {
    expect(resolveEffectiveProviderPolicy(disabledPublicPolicy, false)).toEqual({
      claudeSubscription: { enabled: false },
      codexSubscription: { enabled: false },
    });
  });

  it("enables external subscription Providers only in a private-local build", () => {
    expect(resolveEffectiveProviderPolicy(disabledPublicPolicy, true)).toEqual({
      claudeSubscription: { enabled: true },
      codexSubscription: { enabled: true },
    });
  });
});
