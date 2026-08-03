import { expect, test } from "@playwright/test";
import { launchProviderTestApp } from "./fixtures/provider-test-main";

test("onboarding selects canonical external CLIs and shows public policy gates", async () => {
  const app = await launchProviderTestApp();
  try {
    const page = await app.firstWindow();
    await expect(page.getByText("連接你的程式代理")).toBeVisible();
    await expect(page.getByText(/只會把執行所需的內容送給你選擇的服務/i)).toBeVisible();

    await page.getByRole("button", { name: "選擇 Claude CLI" }).click();
    const claude = page.getByLabel("Claude 狀態");
    await expect(claude).toContainText(app.claudePath);
    await expect(claude).toContainText("2.1.206");
    await expect(claude).toContainText("目前未開放");

    await page.getByRole("button", { name: "選擇 Codex CLI" }).click();
    const codex = page.getByLabel("Codex 狀態");
    await expect(codex).toContainText(app.codexPath);
    await expect(codex).toContainText("0.144.6");
    await expect(codex).toContainText("目前未開放");
    await expect(page.getByText(/token|api key|account id/i)).toHaveCount(0);
  } finally {
    await app.cleanup();
  }
});
