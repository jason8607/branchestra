import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { createGitRepository } from "../tests/fixtures/git-repository";
import { launchBranchestraE2E } from "./support/branchestra-app";

test("exports an opt-in redacted diagnostic bundle to a Main-selected destination", async () => {
  const repository = createGitRepository();
  const app = await launchBranchestraE2E({
    scenario: "two-round-success",
    repositoryRoot: repository.root
  });
  try {
    const page = await app.firstWindow();
    await page.getByText("設定與資料").click();
    await expect(page.getByText(/不包含訊息、原始碼、差異內容、原始代理事件/)).toBeVisible();
    await page.getByRole("button", { name: "匯出診斷資料" }).click();
    await expect(page.getByText(/診斷資料已匯出（\d+ 位元組）/)).toBeVisible();

    const destination = join(app.userDataDir, "branchestra-diagnostics.json.gz");
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    const decoded = gunzipSync(readFileSync(destination)).toString("utf8");
    expect(decoded).toContain('"schemaVersion": 1');
    expect(decoded).not.toContain(repository.root);
    expect(decoded).not.toContain("ANTHROPIC_API_KEY");
  } finally {
    await app.close().catch(() => undefined);
    repository.cleanup();
    rmSync(app.userDataDir, { recursive: true, force: true });
  }
});
