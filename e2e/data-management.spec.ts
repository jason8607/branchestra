import { rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { createGitRepository } from "../tests/fixtures/git-repository";
import { launchBranchestraE2E } from "./support/branchestra-app";
import { createAndApproveTask } from "./support/branchestra-app";

test("shows consequences and removes only explicitly confirmed task-free room metadata", async () => {
  const repository = createGitRepository();
  const app = await launchBranchestraE2E({
    scenario: "two-round-success",
    repositoryRoot: repository.root
  });
  try {
    const page = await app.firstWindow();
    await app.chooseRepository();
    await page.getByTestId("room-title-input").fill("Disposable room");
    await page.getByTestId("create-room").click();
    await expect(page.getByText("Disposable room").first()).toBeVisible();

    await page.getByText("設定與資料").click();
    await page.getByRole("button", { name: "移除房間本機資料" }).click();
    await expect(page.getByText(/不會刪除 Git 儲存庫、分支、Git 物件或代理帳號/)).toBeVisible();
    await expect(page.getByText("將移除 0 個事件與 0 個任務。")).toBeVisible();
    const confirmation = page.getByLabel("輸入下列文字確認");
    await confirmation.fill(await confirmation.getAttribute("placeholder") ?? "");
    await page.getByRole("button", { name: "確認移除本機資料" }).click();

    await expect(page.getByText("房間的本機資料已移除；之後只能從檔案系統備份復原")).toBeVisible();
    await expect(page.getByText("Disposable room")).toHaveCount(0);
    expect((await repository.run(["rev-parse", "HEAD"])).stdout.trim()).toBe(repository.initialOid);
  } finally {
    await app.close().catch(() => undefined);
    repository.cleanup();
    rmSync(app.userDataDir, { recursive: true, force: true });
  }
});

test("archives explicitly confirmed dirty worktree bytes without deleting Git refs", async () => {
  const repository = createGitRepository();
  const app = await launchBranchestraE2E({
    scenario: "two-round-success",
    repositoryRoot: repository.root
  });
  try {
    const page = await app.firstWindow();
    await createAndApproveTask(page, app, "@Claude implement the cleanup archive fixture");
    await expect(page.getByTestId("task-state")).toHaveText("等待你的核准", { timeout: 30_000 });
    await page.getByRole("button", { name: "核准最終合併" }).click();
    await expect(page.getByTestId("task-state")).toHaveText("已完成", { timeout: 15_000 });
    app.writeManagedWorktreeFile("greeting.txt", "untracked.txt", "keep archived bytes\n");

    await page.getByText("設定與資料").click();
    await page.getByRole("button", { name: "封存 lead worktree" }).click();
    await expect(page.getByText("這個 worktree 含有未提交內容，需要明確確認後才能封存。")).toBeVisible();
    await page.getByLabel("一併封存未提交的 worktree 內容").check();
    await page.getByRole("button", { name: "確認封存 worktree" }).click();

    await expect(page.getByText(/Worktree 已封存至 .*recovery\/worktrees/)).toBeVisible();
    expect(app.readRecoveryWorktreeFile("untracked.txt")).toBe("keep archived bytes\n");
    expect(await app.managedBranchExists()).toBe(true);
  } finally {
    await app.close().catch(() => undefined);
    repository.cleanup();
    rmSync(app.userDataDir, { recursive: true, force: true });
  }
});

test("removes explicitly confirmed empty project metadata without deleting the repository", async () => {
  const repository = createGitRepository();
  const app = await launchBranchestraE2E({
    scenario: "two-round-success",
    repositoryRoot: repository.root
  });
  try {
    const page = await app.firstWindow();
    await app.chooseRepository();
    await page.getByText("設定與資料").click();
    await page.getByRole("button", { name: "移除專案本機資料" }).click();
    await expect(page.getByText("這個專案有 0 個房間與 0 個任務。")).toBeVisible();
    const confirmation = page.getByLabel("輸入下列文字確認移除專案資料");
    await confirmation.fill(await confirmation.getAttribute("placeholder") ?? "");
    await page.getByRole("button", { name: "確認移除專案資料" }).click();

    await expect(page.getByText("專案的本機資料已移除；Git 儲存庫未被刪除")).toBeVisible();
    await expect(page.getByRole("button", { name: "加入專案" })).toBeVisible();
    expect((await repository.run(["rev-parse", "HEAD"])).stdout.trim()).toBe(repository.initialOid);
  } finally {
    await app.close().catch(() => undefined);
    repository.cleanup();
    rmSync(app.userDataDir, { recursive: true, force: true });
  }
});
