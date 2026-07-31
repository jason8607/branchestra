import { rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { createGitRepository } from "../tests/fixtures/git-repository";
import { launchBranchestraE2E } from "./support/branchestra-app";

test("untrusted timeline content cannot navigate, open windows, or fabricate controls", async () => {
  const repository = createGitRepository();
  const app = await launchBranchestraE2E({ scenario: "two-round-success", repositoryRoot: repository.root });
  try {
    const page = await app.firstWindow();
    await app.chooseRepository();
    await page.getByTestId("room-title-input").fill("Security room");
    await page.getByTestId("create-room").click();
    const malicious = "<img src=x onerror=alert(1)> <form><input autofocus></form> [unsafe](javascript:alert(1)) [safe](https://example.com/path)";
    await page.getByLabel("Message").fill(malicious);
    await page.getByRole("button", { name: "Send message" }).click();

    const timeline = page.getByTestId("shared-timeline");
    await expect(page.getByRole("button", { name: "Approve final merge" })).toHaveCount(0);
    await expect(timeline).toContainText("onerror=alert(1)");
    await expect(timeline.locator("img, form, input, iframe, object, embed, svg")).toHaveCount(0);
    await expect(timeline.locator('a[href^="javascript:"]')).toHaveCount(0);
    await expect(timeline.locator('a[href="https://example.com/path"]')).toHaveCount(1);

    const originalUrl = page.url();
    await page.evaluate(() => { window.open("https://example.com/popup", "_blank"); });
    await expect.poll(() => app.windowCount()).toBe(1);
    await page.evaluate(() => { window.location.href = "https://example.com/navigation"; });
    await expect.poll(() => page.url()).toBe(originalUrl);
  } finally {
    await app.close().catch(() => undefined);
    repository.cleanup();
    rmSync(app.userDataDir, { recursive: true, force: true });
  }
});
