import { rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { createAndApproveTask } from "./support/branchestra-app";
import { launchPackagedTestApp } from "./support/launch-test-app";

test("app preserves a reviewed task across a utility-worker crash and restart", async () => {
  const { app, repository, packaged } = await launchPackagedTestApp();
  try {
    const page = await app.firstWindow();
    await createAndApproveTask(page, app, "@Claude implement the packaged recovery fixture");
    await expect(page.getByTestId("task-state")).toHaveText("HumanApproval", { timeout: 30_000 });

    await app.crashWorkerForTest();
    await expect(page.getByTestId("task-state")).toHaveText("Interrupted", { timeout: 30_000 });
    await page.getByRole("button", { name: "Preview recovery" }).click();
    await expect(page.getByText("No side effects replayed")).toBeVisible();
    await page.getByRole("button", { name: "Resume recorded phase" }).click();
    await expect(page.getByTestId("task-state")).toHaveText("HumanApproval");
    await page.getByRole("button", { name: "Approve final merge" }).click();
    await expect(page.getByTestId("task-state")).toHaveText("Completed", { timeout: 15_000 });
    if (process.env.BRANCHESTRA_PACKAGED_E2E === "1") expect(packaged).toBe(true);
  } finally {
    await app.close().catch(() => undefined);
    repository.cleanup();
    rmSync(app.userDataDir, { recursive: true, force: true });
  }
});
