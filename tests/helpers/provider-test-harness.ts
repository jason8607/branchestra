import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderId } from "../../src/shared/contracts/provider";
import { ProviderHealthService } from "../../src/worker/providers/provider-health-service";
import { ProviderRepository } from "../../src/worker/storage/provider-repository";
import { openTestDatabase } from "../fixtures/test-database";

export async function createProviderTestHarness(input: {
  provider: ProviderId;
  versionOutput: string;
  authOutput: string;
  privateLocalProviders?: boolean;
}) {
  const root = await mkdtemp(join(tmpdir(), "branchestra-provider-"));
  const executablePath = join(root, input.provider);
  await writeFile(executablePath, "#!/bin/sh\n", "utf8");
  await chmod(executablePath, 0o755);
  const { db } = openTestDatabase();
  const runner = async (_executable: string, args: readonly string[]) => ({
    stdout: args.includes("--version") ? input.versionOutput : input.authOutput,
    stderr: "",
  });
  const service = new ProviderHealthService({
    repository: new ProviderRepository(db), runner,
    host: { homeDirectory: root, temporaryDirectory: root, userName: "tester", architecture: "arm64", resourcesRootRealpath: root },
    validateCodexSubscriptionConfigLock: async () => ({ valid: true as const, realpath: join(root, "subscription.config.lock.toml") }),
    ...(input.privateLocalProviders
      ? { policy: { claudeSubscription: { enabled: true }, codexSubscription: { enabled: true } } }
      : {}),
  });
  return { db, service, executablePath };
}
