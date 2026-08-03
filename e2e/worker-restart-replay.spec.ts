import { rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { createGitRepository } from "../tests/fixtures/git-repository";
import { createAndApproveTask, launchBranchestraE2E } from "./support/branchestra-app";

test("worker restart replays durable state into Interrupted without replaying side effects", async () => {
  const repository = createGitRepository();
  const first = await launchBranchestraE2E({ scenario: "interrupted-run", repositoryRoot: repository.root });
  const userDataDir = first.userDataDir;
  try {
    const page = await first.firstWindow();
    await createAndApproveTask(page, first, "@Codex create partial.txt");
    await expect.poll(() => {
      try {
        return first.readManagedWorktreeFile("partial.txt");
      } catch {
        return "";
      }
    }, { timeout: 15_000 })
      .toBe("keep after restart\n");
    await first.close();

    const second = await launchBranchestraE2E({
      scenario: "interrupted-run",
      repositoryRoot: repository.root,
      userDataDir
    });
    try {
      const resumed = await second.firstWindow();
      await expect(resumed.getByTestId("task-state")).toHaveText("已中斷", { timeout: 15_000 });
      await resumed.getByRole("button", { name: "預覽復原方案" }).click();
      await expect(resumed.getByText("尚未重播任何副作用")).toBeVisible();
      await resumed.getByRole("button", { name: "從記錄階段繼續" }).click();
      await resumed.getByRole("button", { name: "停止任務" }).click();
      await expect(resumed.getByTestId("task-state")).toHaveText("已取消");
      expect(second.readManagedWorktreeFile("partial.txt")).toBe("keep after restart\n");
      expect(await second.managedBranchExists()).toBe(true);
    } finally {
      await second.close().catch(() => undefined);
    }
  } finally {
    await first.close().catch(() => undefined);
    repository.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
