import { describe, expect, it } from "vitest";
process.env.BRANCHESTRA_BUNDLE_ID = "com.example.branchestra";
process.env.BRANCHESTRA_GITHUB_OWNER = "example";
const { codexLockExtraResources, createBuilderConfig } = await import("../../electron-builder.config.mjs");

const releaseEnvironment = {
  BRANCHESTRA_BUNDLE_ID: "com.example.branchestra",
  BRANCHESTRA_GITHUB_OWNER: "example",
};

describe("electron-builder configuration", () => {
  it("packages both the reviewed Codex lock and the manifest required to validate it", () => {
    expect(codexLockExtraResources({
      repositoryPath: "resources/codex/0.144.6/subscription.config.lock.toml",
      packagedRelativePath: "codex/subscription.config.lock.toml",
    })).toEqual([
      { from: "config/codex-config-lock-manifest.json", to: "codex-config-lock-manifest.json" },
      { from: "resources/codex/0.144.6/subscription.config.lock.toml", to: "codex/subscription.config.lock.toml" },
    ]);
  });

  it("retains signing, notarization, and public artifacts for release builds", () => {
    const config = createBuilderConfig(releaseEnvironment);
    expect(config.mac.forceCodeSigning).toBe(true);
    expect(config.mac.notarize).toBe(true);
    expect(config.mac.target).toEqual(["dmg", "zip"]);
    expect(config.directories.output).toBe("release");
  });

  it("makes only the private-local build unsigned, arm64-ZIP oriented, and non-publishing", () => {
    const config = createBuilderConfig({
      ...releaseEnvironment,
      BRANCHESTRA_BUILD_PRIVATE_LOCAL_PROVIDERS: "1",
    });
    expect(config.mac.forceCodeSigning).toBe(false);
    expect(config.mac.notarize).toBe(false);
    expect(config.mac.target).toEqual(["zip"]);
    expect(config.mac.artifactName).toContain("local");
    expect(config.directories.output).toBe("release/local");
    expect(config.publish).toBeNull();
    expect(config.files).toContain("!**/node_modules/@anthropic-ai/claude-agent-sdk/vendor/**");
    expect(config.files).not.toContain("!**/node_modules/@anthropic-ai/claude-agent-sdk{,/**}");
  });
});
