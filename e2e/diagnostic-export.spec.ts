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
    await page.getByText("Settings").click();
    await expect(page.getByText("It excludes messages, source files, diffs, raw Provider events, environment values, and authentication output.")).toBeVisible();
    await page.getByRole("button", { name: "Export diagnostics" }).click();
    await expect(page.getByText(/Diagnostic bundle exported \(\d+ bytes\)/)).toBeVisible();

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
