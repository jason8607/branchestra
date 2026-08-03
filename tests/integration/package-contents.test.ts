import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyPackageContents } from "../../scripts/verify-package-contents.mjs";

async function appFixture() {
  const root = await mkdtemp(join(tmpdir(), "branchestra-package-"));
  const app = join(root, "Branchestra.app");
  const resources = join(app, "Contents", "Resources");
  await mkdir(resources, { recursive: true });
  await writeFile(join(resources, "safe.txt"), "safe", "utf8");
  return { app, resources };
}

describe("packaged content gate", () => {
  it("accepts an app fixture without Provider payloads", async () => {
    const fixture = await appFixture();
    await expect(verifyPackageContents(fixture.app)).resolves.toBe(true);
  });

  it.each(["codex", "claude", "auth.json", "bundle.js.map"])("rejects forbidden resource %s", async (name) => {
    const fixture = await appFixture();
    const target = join(fixture.resources, name);
    await writeFile(target, "forbidden", "utf8");
    if (name === "codex") await chmod(target, 0o755);
    await expect(verifyPackageContents(fixture.app)).rejects.toThrow("Forbidden packaged");
  });

  it("verifies a packaged private-local Codex lock against the reviewed manifest", async () => {
    const fixture = await appFixture();
    const manifest = JSON.parse(await readFile("config/codex-config-lock-manifest.json", "utf8")) as { packagedRelativePath: string; repositoryPath: string };
    const lock = await readFile(manifest.repositoryPath);
    const packagedLock = join(fixture.resources, manifest.packagedRelativePath);
    await mkdir(join(packagedLock, ".."), { recursive: true });
    await writeFile(join(fixture.resources, "codex-config-lock-manifest.json"), await readFile("config/codex-config-lock-manifest.json"));
    await writeFile(packagedLock, lock);
    await expect(verifyPackageContents(fixture.app)).resolves.toBe(true);
    await writeFile(packagedLock, Buffer.concat([lock, Buffer.from("changed")]));
    await expect(verifyPackageContents(fixture.app)).rejects.toThrow("Packaged Codex config lock");
  });
});
