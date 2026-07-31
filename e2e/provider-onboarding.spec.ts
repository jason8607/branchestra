import { expect, test } from "@playwright/test";
import { launchProviderTestApp } from "./fixtures/provider-test-main";

test("onboarding selects canonical external CLIs and shows public policy gates", async () => {
  const app = await launchProviderTestApp();
  try {
    const page = await app.firstWindow();
    await expect(page.getByText("Connect external coding agents")).toBeVisible();
    await expect(page.getByText(/context is sent to the selected provider/i)).toBeVisible();

    await page.getByRole("button", { name: "Choose Claude CLI" }).click();
    const claude = page.getByLabel("Claude health");
    await expect(claude).toContainText(app.claudePath);
    await expect(claude).toContainText("2.1.206");
    await expect(claude).toContainText("policy disabled");

    await page.getByRole("button", { name: "Choose Codex CLI" }).click();
    const codex = page.getByLabel("Codex health");
    await expect(codex).toContainText(app.codexPath);
    await expect(codex).toContainText("0.144.6");
    await expect(codex).toContainText("policy disabled");
    await expect(page.getByText(/token|api key|account id/i)).toHaveCount(0);
  } finally {
    await app.cleanup();
  }
});
