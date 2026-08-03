import { rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { createAndApproveTask } from "./support/branchestra-app";
import { launchPackagedTestApp } from "./support/launch-test-app";

test("app preserves a reviewed task across a utility-worker crash and restart", async () => {
  const { app, repository, packaged } = await launchPackagedTestApp();
  try {
    const page = await app.firstWindow();
    await createAndApproveTask(page, app, "@Claude implement the packaged recovery fixture");
    await expect(page.getByTestId("task-state")).toHaveText("等待你的核准", { timeout: 30_000 });

    await app.crashWorkerForTest();
    await expect(page.getByTestId("task-state")).toHaveText("已中斷", { timeout: 30_000 });
    await page.getByRole("button", { name: "預覽復原方案" }).click();
    await expect(page.getByText("尚未重播任何副作用")).toBeVisible();
    await page.getByRole("button", { name: "從記錄階段繼續" }).click();
    await expect(page.getByTestId("task-state")).toHaveText("等待你的核准");
    await page.getByRole("button", { name: "核准最終合併" }).click();
    await expect(page.getByTestId("task-state")).toHaveText("已完成", { timeout: 15_000 });
    if (process.env.BRANCHESTRA_PACKAGED_E2E === "1") expect(packaged).toBe(true);
  } finally {
    await app.close().catch(() => undefined);
    repository.cleanup();
    rmSync(app.userDataDir, { recursive: true, force: true });
  }
});
