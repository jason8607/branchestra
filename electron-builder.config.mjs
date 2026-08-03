import fs from "node:fs";
import { validateReleaseConfig } from "./scripts/validate-release-config.mjs";

export function codexLockExtraResources(manifest) {
  return [
    { from: "config/codex-config-lock-manifest.json", to: "codex-config-lock-manifest.json" },
    { from: manifest.repositoryPath, to: manifest.packagedRelativePath },
  ];
}

export function createBuilderConfig(environment) {
  const { bundleId } = validateReleaseConfig(environment);
  const privateLocalProviders = environment.BRANCHESTRA_BUILD_PRIVATE_LOCAL_PROVIDERS === "1";
  const policy = JSON.parse(fs.readFileSync("config/provider-policy.json", "utf8"));
  const files = [
    "out/**",
    "package.json",
    "!**/*.map",
    ...(policy.publicFeatures.claudeSubscription || privateLocalProviders
      ? ["!**/node_modules/@anthropic-ai/claude-agent-sdk/vendor/**"]
      : ["!**/node_modules/@anthropic-ai/claude-agent-sdk{,/**}"]),
    "!**/node_modules/@anthropic-ai/claude-agent-sdk-darwin-*/**",
    "!**/node_modules/@anthropic-ai/claude-agent-sdk-linux-*/**",
    "!**/node_modules/@anthropic-ai/claude-agent-sdk-win32-*/**",
    "!**/node_modules/@openai/codex{,/**}",
    "!**/node_modules/@openai/codex-darwin-*/**",
    "!**/node_modules/@openai/codex-linux-*/**",
    "!**/node_modules/@openai/codex-win32-*/**",
  ];
  const extraResources = [];
  const manifestPath = "config/codex-config-lock-manifest.json";
  if (policy.publicFeatures.codexSubscription || (privateLocalProviders && fs.existsSync(manifestPath))) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    extraResources.push(...codexLockExtraResources(manifest));
  }

  return {
    appId: bundleId,
    productName: "Branchestra",
    electronVersion: "43.1.1",
    asar: true,
    directories: { output: privateLocalProviders ? "release/local" : "release" },
    files,
    extraResources,
    mac: {
      category: "public.app-category.developer-tools",
      minimumSystemVersion: "12.0",
      target: privateLocalProviders ? ["zip"] : ["dmg", "zip"],
      hardenedRuntime: true,
      gatekeeperAssess: false,
      forceCodeSigning: !privateLocalProviders,
      notarize: !privateLocalProviders,
      entitlements: "build/entitlements.mac.plist",
      entitlementsInherit: "build/entitlements.mac.inherit.plist",
      artifactName: privateLocalProviders
        ? "Branchestra-${version}-local-mac-${arch}.${ext}"
        : "Branchestra-${version}-mac-${arch}.${ext}",
    },
    dmg: { sign: false },
    publish: null,
  };
}

export default createBuilderConfig(process.env);
