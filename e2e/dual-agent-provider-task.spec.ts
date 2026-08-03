import { rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { createGitRepository } from "../tests/fixtures/git-repository";
import { createAndApproveTask, launchBranchestraE2E } from "./support/branchestra-app";

test("dual-agent provider task approves, collaborates twice, verifies, and merges only after final approval", async () => {
  const repository = createGitRepository();
  const app = await launchBranchestraE2E({ scenario: "two-round-success", repositoryRoot: repository.root });
  try {
    const page = await app.firstWindow();
    await createAndApproveTask(page, app, "@Claude implement the greeting");
    await expect.poll(async () => {
      const state = await page.getByTestId("task-state").innerText();
      if (state === "失敗") throw new Error(await page.locator("body").innerText());
      return state;
    }, { timeout: 30_000 }).toBe("等待你的核准");
    await expect(page.getByLabel("協作回合 2 / 2")).toBeVisible();
    await expect(page.getByText("unit — 通過")).toBeVisible();
    expect((await repository.run(["rev-parse", "refs/heads/main"])).stdout.trim()).toBe(repository.initialOid);
    await page.getByRole("button", { name: "核准最終合併" }).click();
    await expect(page.getByTestId("task-state")).toHaveText("已完成", { timeout: 15_000 });
    expect((await repository.run(["show", "refs/heads/main:greeting.txt"])).stdout).toBe("hello from both agents\n");
  } finally {
    await app.close().catch(() => undefined);
    repository.cleanup();
    rmSync(app.userDataDir, { recursive: true, force: true });
  }
});
