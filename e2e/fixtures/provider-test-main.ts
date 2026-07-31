import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitRepository } from "../../tests/fixtures/git-repository";
import { launchBranchestraE2E } from "../support/branchestra-app";

export async function launchProviderTestApp() {
  const repository = createGitRepository();
  const providerRoot = await mkdtemp(join(tmpdir(), "branchestra-provider-e2e-"));
  const claudePath = join(providerRoot, "claude");
  const codexPath = join(providerRoot, "codex");
  await Promise.all([
    writeFile(claudePath, "#!/bin/sh\nprintf '2.1.206\\n'\n", "utf8"),
    writeFile(codexPath, "#!/bin/sh\nprintf 'codex-cli 0.144.6\\n'\n", "utf8")
  ]);
  await Promise.all([chmod(claudePath, 0o755), chmod(codexPath, 0o755)]);
  const app = await launchBranchestraE2E({
    scenario: "two-round-success",
    repositoryRoot: repository.root,
    providerPaths: { claude: claudePath, codex: codexPath }
  });
  return {
    ...app,
    claudePath,
    codexPath,
    async cleanup() {
      await app.close().catch(() => undefined);
      repository.cleanup();
      await Promise.all([
        rm(providerRoot, { recursive: true, force: true }),
        rm(app.userDataDir, { recursive: true, force: true })
      ]);
    }
  };
}
