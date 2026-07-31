import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { createGitRepository } from "../../tests/fixtures/git-repository";
import { launchBranchestraE2E } from "./branchestra-app";

export async function launchPackagedTestApp() {
  const repository = createGitRepository();
  const packaged = process.env.BRANCHESTRA_PACKAGED_E2E === "1";
  const executablePath = resolve("release/e2e/mac-arm64/Branchestra.app/Contents/MacOS/Branchestra");
  if (packaged) await access(executablePath);
  const app = await launchBranchestraE2E({
    scenario: "two-round-success",
    repositoryRoot: repository.root,
    ...(packaged ? { executablePath } : {})
  });
  return { app, repository, packaged };
}
