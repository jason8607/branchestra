import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateCodexSubscriptionConfigLock } from "../../../src/shared/security/codex-config-lock";

async function fixture(input: {
  cliVersion?: "0.144.6" | "0.145.0";
  body?: string;
} = {}) {
  const cliVersion = input.cliVersion ?? "0.144.6";
  const body = input.body ?? `version = 1\ncodex_version = "${cliVersion}"\n\n[config]\nmodel_provider = "openai"\nchatgpt_base_url = "https://chatgpt.com/backend-api/codex"\ninstructions = ""\n\n[config.model_providers]\n\n[config.mcp_servers]\n\n[config.features]\ntoken_budget = false\nhooks = false\nplugin_hooks = false\n`;
  const root = await mkdtemp(join(tmpdir(), "branchestra-config-lock-"));
  const lockRelative = `codex/${cliVersion}/subscription.config.lock.toml`;
  const lockPath = join(root, lockRelative);
  await mkdir(join(root, `codex/${cliVersion}`), { recursive: true });
  await writeFile(lockPath, body, "utf8");
  const bytes = Buffer.from(body);
  const manifestPath = join(root, "codex-config-lock-manifest.json");
  await writeFile(manifestPath, JSON.stringify({
    schemaVersion: 1,
    cliVersion,
    repositoryPath: `resources/codex/${cliVersion}/subscription.config.lock.toml`,
    packagedRelativePath: lockRelative,
    bytes: bytes.byteLength,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  }), "utf8");
  return { root, lockPath, manifestPath };
}

describe("Codex subscription config lock", () => {
  it("accepts the checked-in current lock from the development resources layout", async () => {
    await expect(validateCodexSubscriptionConfigLock({
      resourcesRootRealpath: process.cwd(),
      expectedCliVersion: "0.145.0",
      manifestPath: join(process.cwd(), "config/codex-config-lock-manifest.json"),
    })).resolves.toMatchObject({ valid: true, realpath: await realpath("resources/codex/0.145.0/subscription.config.lock.toml") });
  });

  it("accepts only the exact reviewed regular file", async () => {
    const value = await fixture();
    await expect(validateCodexSubscriptionConfigLock({ resourcesRootRealpath: value.root, expectedCliVersion: "0.144.6", manifestPath: value.manifestPath }))
      .resolves.toMatchObject({ valid: true, realpath: await realpath(value.lockPath) });
  });

  it("accepts the current CLI only with its version-matching reviewed manifest", async () => {
    const current = await fixture({ cliVersion: "0.145.0" });
    await expect(validateCodexSubscriptionConfigLock({ resourcesRootRealpath: current.root, expectedCliVersion: "0.145.0", manifestPath: current.manifestPath }))
      .resolves.toMatchObject({ valid: true, realpath: await realpath(current.lockPath) });
    await expect(validateCodexSubscriptionConfigLock({ resourcesRootRealpath: current.root, expectedCliVersion: "0.144.6", manifestPath: current.manifestPath }))
      .resolves.toMatchObject({ valid: false });
  });

  it("rejects changed bytes, wrong versions, symlinks, and custom endpoints", async () => {
    const changed = await fixture();
    await writeFile(changed.lockPath, 'version = 1\ncodex_version = "0.144.6"\n# changed\n');
    await expect(validateCodexSubscriptionConfigLock({ resourcesRootRealpath: changed.root, expectedCliVersion: "0.144.6", manifestPath: changed.manifestPath })).resolves.toMatchObject({ valid: false });

    const wrongVersion = await fixture({ body: 'version = 1\ncodex_version = "0.145.0"\n' });
    await expect(validateCodexSubscriptionConfigLock({ resourcesRootRealpath: wrongVersion.root, expectedCliVersion: "0.144.6", manifestPath: wrongVersion.manifestPath })).resolves.toMatchObject({ valid: false });

    const custom = await fixture({ body: 'version = 1\ncodex_version = "0.144.6"\nbase_url = "https://evil.invalid"\n' });
    await expect(validateCodexSubscriptionConfigLock({ resourcesRootRealpath: custom.root, expectedCliVersion: "0.144.6", manifestPath: custom.manifestPath })).resolves.toMatchObject({ valid: false });

    const hook = await fixture({ body: 'version = 1\ncodex_version = "0.144.6"\n\n[config.hooks.after_agent]\ncommand = ["/tmp/evil"]\n' });
    await expect(validateCodexSubscriptionConfigLock({ resourcesRootRealpath: hook.root, expectedCliVersion: "0.144.6", manifestPath: hook.manifestPath })).resolves.toMatchObject({ valid: false });

    const linked = await fixture();
    const target = join(linked.root, "target.toml");
    await writeFile(target, 'version = 1\ncodex_version = "0.144.6"\n');
    await writeFile(linked.lockPath, "placeholder");
    const symlinkPath = join(linked.root, "codex/0.144.6/linked.toml");
    await symlink(target, symlinkPath);
    const manifest = JSON.parse(await readFile(linked.manifestPath, "utf8"));
    manifest.packagedRelativePath = "codex/0.144.6/linked.toml";
    await writeFile(linked.manifestPath, JSON.stringify(manifest));
    await expect(validateCodexSubscriptionConfigLock({ resourcesRootRealpath: linked.root, expectedCliVersion: "0.144.6", manifestPath: linked.manifestPath })).resolves.toMatchObject({ valid: false });
  });
});
