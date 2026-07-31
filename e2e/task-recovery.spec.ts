import { rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { createGitRepository } from "../tests/fixtures/git-repository";
import { createAndApproveTask, launchBranchestraE2E } from "./support/branchestra-app";

test("relaunches into Interrupted, previews recovery, and retains cancellation output", async () => {
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
      await expect(resumed.getByTestId("task-state")).toHaveText("Interrupted", { timeout: 15_000 });
      await resumed.getByRole("button", { name: "Preview recovery" }).click();
      await expect(resumed.getByText("No side effects replayed")).toBeVisible();
      await resumed.getByRole("button", { name: "Resume recorded phase" }).click();
      await resumed.getByRole("button", { name: "Stop task" }).click();
      await expect(resumed.getByTestId("task-state")).toHaveText("Cancelled");
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
