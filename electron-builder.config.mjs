import fs from "node:fs";
import { validateReleaseConfig } from "./scripts/validate-release-config.mjs";

const { bundleId } = validateReleaseConfig(process.env);
const policy = JSON.parse(fs.readFileSync("config/provider-policy.json", "utf8"));
const files = [
  "out/**",
  "package.json",
  "!**/*.map",
  ...(policy.publicFeatures.claudeSubscription
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
if (policy.publicFeatures.codexSubscription) {
  const manifest = JSON.parse(fs.readFileSync("config/codex-config-lock-manifest.json", "utf8"));
  extraResources.push({ from: manifest.repositoryPath, to: manifest.packagedRelativePath });
}

export default {
  appId: bundleId,
  productName: "Branchestra",
  electronVersion: "43.1.1",
  asar: true,
  directories: { output: "release" },
  files,
  extraResources,
  mac: {
    category: "public.app-category.developer-tools",
    minimumSystemVersion: "12.0",
    target: ["dmg", "zip"],
    hardenedRuntime: true,
    gatekeeperAssess: false,
    forceCodeSigning: true,
    notarize: true,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.inherit.plist",
    artifactName: "Branchestra-${version}-mac-${arch}.${ext}",
  },
  dmg: { sign: false },
  publish: null,
};
