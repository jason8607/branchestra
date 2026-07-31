import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function readTrackedFile(repoRoot, relativePath, permittedRoot) {
  if (path.isAbsolute(relativePath)) throw new Error("Release evidence path must be repository-relative");
  const requested = path.resolve(repoRoot, relativePath);
  const canonical = fs.realpathSync(requested);
  if (!inside(fs.realpathSync(permittedRoot), canonical)) throw new Error("Release evidence escaped its permitted directory");
  const stat = fs.lstatSync(requested);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Release evidence must be a regular non-symlink file");
  execFileSync("/usr/bin/git", ["-C", repoRoot, "ls-files", "--error-unmatch", "--", relativePath], { stdio: "ignore" });
  const dirty = execFileSync("/usr/bin/git", ["-C", repoRoot, "status", "--porcelain=v1", "--", relativePath], { encoding: "utf8" }).trim();
  if (dirty) throw new Error(`Release evidence must be clean at the release commit: ${relativePath}`);
  return fs.readFileSync(requested);
}

function readProviderEvidence(repoRoot, relativePath) {
  return readTrackedFile(repoRoot, relativePath, path.join(repoRoot, "config/provider-evidence"));
}

function readConfigLockInput(repoRoot, relativePath) {
  const permitted = new Set(["config/codex-config-lock-manifest.json", "resources/codex/0.144.6/subscription.config.lock.toml"]);
  if (!permitted.has(relativePath)) throw new Error("Unexpected Codex config-lock path");
  return readTrackedFile(repoRoot, relativePath, repoRoot);
}

function reviewAgeDays(reviewedAt, now) {
  return Math.floor((now.getTime() - Date.parse(`${reviewedAt}T00:00:00Z`)) / 86_400_000);
}

function verifyEnabledProvider(provider, record, now, repoRoot) {
  if (!record.policyEvidence?.path || !record.policyEvidence.scope) throw new Error(`${provider} requires scoped policy evidence`);
  const policyBody = readProviderEvidence(repoRoot, record.policyEvidence.path).toString("utf8");
  if (!policyBody.includes(record.sourceUrl) || !policyBody.includes(record.policyEvidence.scope)) throw new Error(`${provider} evidence does not bind source and scope`);
  let expectedCodexLockHash = null;
  if (provider === "codex") {
    const manifest = JSON.parse(readConfigLockInput(repoRoot, "config/codex-config-lock-manifest.json").toString("utf8"));
    if (manifest.schemaVersion !== 1 || manifest.cliVersion !== record.cliVersion || !/^sha256:[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error("Codex config-lock manifest is invalid");
    const lockBytes = readConfigLockInput(repoRoot, manifest.repositoryPath);
    expectedCodexLockHash = `sha256:${createHash("sha256").update(lockBytes).digest("hex")}`;
    if (lockBytes.byteLength !== manifest.bytes || expectedCodexLockHash !== manifest.sha256) throw new Error("Codex config lock does not match its reviewed manifest");
  }
  const expected = new Set(["arm64", "x64"]);
  for (const reportPath of record.enforcementReports ?? []) {
    const report = JSON.parse(readProviderEvidence(repoRoot, reportPath).toString("utf8"));
    const age = Math.floor((now.getTime() - Date.parse(report.smokeAt)) / 86_400_000);
    if (!expected.has(report.architecture) || report.provider !== provider || report.sdkVersion !== record.sdkVersion
      || report.cliVersion !== record.cliVersion || report.decision !== "supported" || report.realProviderSmoke !== true
      || (provider === "codex" && (report.configLockHash !== expectedCodexLockHash
        || report.configLockCliVersion !== record.cliVersion || report.configIsolationCanary !== true))
      || !/^sha256:[a-f0-9]{64}$/.test(report.profileHash) || !Number.isFinite(age) || age < 0 || age > 30) {
      throw new Error(`${provider} has invalid or stale enforcement evidence: ${reportPath}`);
    }
    expected.delete(report.architecture);
  }
  if (expected.size) throw new Error(`${provider} requires current arm64 and x64 enforcement reports`);
}

export function verifyPolicy(policy, now = new Date(), repoRoot = process.cwd()) {
  if (policy.schemaVersion !== 1) throw new Error("Unsupported provider policy schema");
  for (const provider of ["claude", "codex"]) {
    const age = reviewAgeDays(policy.providers[provider].reviewedAt, now);
    if (!Number.isFinite(age) || age < 0 || age > 30) throw new Error(`${provider} policy review must be within 30 days of release`);
  }
  const claude = policy.providers.claude;
  if (policy.publicFeatures.claudeSubscription && (claude.status !== "approved" || claude.policyEvidence?.kind !== "written_approval")) {
    throw new Error("claudeSubscription cannot be enabled without written Anthropic approval evidence");
  }
  if (policy.publicFeatures.claudeSubscription) verifyEnabledProvider("claude", claude, now, repoRoot);
  const codex = policy.providers.codex;
  if (policy.publicFeatures.codexSubscription && codex.status !== "allowed") throw new Error("codexSubscription cannot be enabled without a current allowed policy decision");
  if (policy.publicFeatures.codexSubscription) verifyEnabledProvider("codex", codex, now, repoRoot);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyPolicy(JSON.parse(fs.readFileSync("config/provider-policy.json", "utf8")));
}
