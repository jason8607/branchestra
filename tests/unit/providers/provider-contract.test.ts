import { describe, expect, it } from "vitest";
import {
  ProviderCapabilitiesSchema,
  ProviderEventSchema,
} from "../../../src/shared/contracts/provider";
import { PUBLIC_PROVIDER_RELEASE_POLICY } from "../../../src/shared/config/provider-release-policy";

describe("provider contract", () => {
  it("requires independently reported capabilities", () => {
    expect(() => ProviderCapabilitiesSchema.parse({ processAbort: true })).toThrow();
    expect(ProviderCapabilitiesSchema.parse({
      interactiveApproval: false,
      protocolInterrupt: false,
      processAbort: true,
      textDeltaStreaming: false,
      itemEventStreaming: true,
      sessionResume: true,
      workspaceWriteSandbox: true,
      toolNetworkControl: true,
      contextTools: "injected",
    })).toBeTruthy();
  });

  it("rejects normalized events without critical semantics", () => {
    expect(() => ProviderEventSchema.parse({ type: "session.started" })).toThrow();
  });

  it("keeps Claude subscription support disabled in public builds", () => {
    expect(PUBLIC_PROVIDER_RELEASE_POLICY.claudeSubscription).toEqual({
      enabled: false,
      writtenApproval: null,
    });
  });
});
