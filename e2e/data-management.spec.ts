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

    await page.getByText("Settings").click();
    await page.getByRole("button", { name: "Remove room metadata" }).click();
    await expect(page.getByText("This does not delete your Git repository, branches, Git objects, or Provider account.")).toBeVisible();
    await expect(page.getByText("0 events and 0 tasks will be removed.")).toBeVisible();
    const confirmation = page.getByLabel("Type to confirm");
    await confirmation.fill(await confirmation.getAttribute("placeholder") ?? "");
    await page.getByRole("button", { name: "Confirm local deletion" }).click();

    await expect(page.getByText("Room metadata removed; filesystem backups are the only recovery source")).toBeVisible();
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
    await expect(page.getByTestId("task-state")).toHaveText("HumanApproval", { timeout: 30_000 });
    await page.getByRole("button", { name: "Approve final merge" }).click();
    await expect(page.getByTestId("task-state")).toHaveText("Completed", { timeout: 15_000 });
    app.writeManagedWorktreeFile("greeting.txt", "untracked.txt", "keep archived bytes\n");

    await page.getByText("Settings").click();
    await page.getByRole("button", { name: "Archive lead worktree" }).click();
    await expect(page.getByText("This worktree has uncommitted bytes and requires explicit archive confirmation.")).toBeVisible();
    await page.getByLabel("Archive uncommitted worktree bytes").check();
    await page.getByRole("button", { name: "Confirm worktree archive" }).click();

    await expect(page.getByText(/Worktree archived at .*recovery\/worktrees/)).toBeVisible();
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
    await page.getByText("Settings").click();
    await page.getByRole("button", { name: "Remove project metadata" }).click();
    await expect(page.getByText("0 rooms and 0 tasks belong to this project.")).toBeVisible();
    const confirmation = page.getByLabel("Type to confirm project deletion");
    await confirmation.fill(await confirmation.getAttribute("placeholder") ?? "");
    await page.getByRole("button", { name: "Confirm project metadata deletion" }).click();

    await expect(page.getByText("Project metadata removed; the Git repository was not deleted")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add Project" })).toBeVisible();
    expect((await repository.run(["rev-parse", "HEAD"])).stdout.trim()).toBe(repository.initialOid);
  } finally {
    await app.close().catch(() => undefined);
    repository.cleanup();
    rmSync(app.userDataDir, { recursive: true, force: true });
  }
});
