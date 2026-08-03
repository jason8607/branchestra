// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProviderHealthStep } from "../../../src/renderer/features/onboarding/ProviderHealthStep";

describe("ProviderHealthStep", () => {
  it("shows local/auth boundaries, repair state, and no credential detail", () => {
    const pick = vi.fn();
    render(<ProviderHealthStep health={[
      { provider: "claude", state: "policy_disabled", executableRealpath: "/opt/homebrew/bin/claude", cliVersion: "2.1.206", sdkVersion: "0.3.216", architecture: "arm64", authLabel: "Subscription-only", capabilities: null, repairAction: "Public Claude runs require written Anthropic approval." },
      { provider: "codex", state: "ready", executableRealpath: "/opt/homebrew/bin/codex", cliVersion: "0.144.6", sdkVersion: "0.144.6", architecture: "arm64", authLabel: "Subscription-only", capabilities: null, repairAction: null },
    ]} onPick={pick} onRefresh={vi.fn()} />);
    expect(screen.getByText(/所有歷程與 Git 結果都留在這台 Mac/i)).not.toBeNull();
    expect(screen.getByText(/只會把執行所需的內容送給你選擇的服務/i)).not.toBeNull();
    expect(screen.getAllByText("僅限訂閱帳號")).toHaveLength(2);
    expect(screen.getByText("此版本尚未開放 Claude 執行。")).not.toBeNull();
    expect(screen.queryByText(/token|api key|account id/i)).toBeNull();
    expect(screen.getByText("已自動連接，不需手動選擇。")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "選擇 Codex CLI" })).toBeNull();
    expect(pick).not.toHaveBeenCalled();
  });
});
