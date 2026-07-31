// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProviderHealthStep } from "../../../src/renderer/features/onboarding/ProviderHealthStep";

describe("ProviderHealthStep", () => {
  it("shows local/auth boundaries, repair state, and no credential detail", async () => {
    const pick = vi.fn();
    render(<ProviderHealthStep health={[
      { provider: "claude", state: "policy_disabled", executableRealpath: "/opt/homebrew/bin/claude", cliVersion: "2.1.206", sdkVersion: "0.3.216", architecture: "arm64", authLabel: "Subscription-only", capabilities: null, repairAction: "Public Claude runs require written Anthropic approval." },
      { provider: "codex", state: "ready", executableRealpath: "/opt/homebrew/bin/codex", cliVersion: "0.144.6", sdkVersion: "0.144.6", architecture: "arm64", authLabel: "Subscription-only", capabilities: null, repairAction: null },
    ]} onPick={pick} onRefresh={vi.fn()} />);
    expect(screen.getByText(/saved on this Mac/i)).not.toBeNull();
    expect(screen.getByText(/context is sent to the selected provider/i)).not.toBeNull();
    expect(screen.getAllByText("Subscription-only")).toHaveLength(2);
    expect(screen.getByText("Public Claude runs require written Anthropic approval.")).not.toBeNull();
    expect(screen.queryByText(/token|api key|account id/i)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Choose Codex CLI" }));
    expect(pick).toHaveBeenCalledWith("codex");
  });
});
