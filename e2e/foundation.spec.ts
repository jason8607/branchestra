import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test, type ElectronApplication } from "@playwright/test";
import { createGitRepository } from "../tests/fixtures/git-repository";
import { launchBranchestra } from "./helpers/launch-branchestra";

test("adds a Git project, persists isolated rooms/messages, and restores them after restart", async () => {
  const repository = createGitRepository();
  const userDataPath = mkdtempSync(join(tmpdir(), "branchestra-e2e-data-"));
  let application: ElectronApplication | undefined;

  try {
    application = await launchBranchestra({
      userDataPath,
      selectedProjectPath: repository.root
    });
    let page = await application.firstWindow();

    await page.getByRole("button", { name: "加入專案" }).click();
    await expect(page.getByTestId("project-rail")).toContainText(basename(repository.root));

    await page.getByTestId("room-title-input").fill("Architecture");
    await page.getByTestId("create-room").click();
    await expect(page.getByRole("button", { name: "Architecture", exact: true })).toBeVisible();
    await expect(page.getByTestId("message-input")).toBeEnabled();
    await page.getByTestId("message-input").fill("Persisted architecture note");
    await page.getByTestId("send-message").click();
    await expect(page.getByTestId("shared-timeline")).toContainText(
      "Persisted architecture note"
    );

    await page.getByTestId("room-title-input").fill("UX");
    await page.getByTestId("create-room").click();
    await expect(page.getByRole("button", { name: "UX", exact: true })).toBeVisible();
    await expect(page.getByTestId("message-input")).toBeEnabled();
    await page.getByTestId("message-input").fill("Persisted UX note");
    await page.getByTestId("send-message").click();
    await expect(page.getByTestId("shared-timeline")).toContainText("Persisted UX note");

    await application.close();
    application = undefined;

    application = await launchBranchestra({
      userDataPath,
      selectedProjectPath: repository.root
    });
    page = await application.firstWindow();
    const rail = page.getByTestId("project-rail");
    await expect(rail).toContainText("Architecture");
    await expect(rail).toContainText("UX");

    await page.getByRole("button", { name: "Architecture", exact: true }).click();
    await expect(page.getByTestId("shared-timeline")).toContainText(
      "Persisted architecture note"
    );
    await expect(page.getByTestId("shared-timeline")).not.toContainText("Persisted UX note");

    await page.getByRole("button", { name: "UX", exact: true }).click();
    await expect(page.getByTestId("shared-timeline")).toContainText("Persisted UX note");
    await expect(page.getByTestId("shared-timeline")).not.toContainText(
      "Persisted architecture note"
    );

    const boundary = await page.evaluate(() => ({
      requireType: typeof (window as unknown as { require?: unknown }).require,
      processType: typeof (window as unknown as { process?: unknown }).process,
      apiKeys: Object.keys(window.branchestra).sort(),
      webviews: document.querySelectorAll("webview").length
    }));
    expect(boundary).toEqual({
      requireType: "undefined",
      processType: "undefined",
      apiKeys: ["request", "subscribe"],
      webviews: 0
    });

    await expect(page.evaluate(() => window.branchestra.request({
      type: "project.addExisting",
      payload: { selectedPath: "/tmp/injected" },
      idempotencyKey: "renderer-path-attempt"
    } as never))).rejects.toThrow();
  } finally {
    if (application !== undefined) {
      await application.close().catch(() => undefined);
    }
    repository.cleanup();
    rmSync(userDataPath, { recursive: true, force: true });
  }
});
