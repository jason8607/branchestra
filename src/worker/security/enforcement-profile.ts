import { createHash } from "node:crypto";
import { stableJson } from "../context/stable-json";

export const REQUIRED_PROBES = [
  "worktree-write", "parent-traversal", "symlink-outside-write", "git-common-dir-write",
  "other-ref-write", "child-outside-write", "credential-env-read", "tool-network-connect",
] as const;
export type ProbeName = (typeof REQUIRED_PROBES)[number];
export type ProbeOutcome = "allowed" | "denied" | "not-run";
export interface EnforcementProfile {
  schemaVersion: 1; provider: "claude" | "codex"; sdkVersion: string; cliVersion: string;
  architecture: "arm64" | "x64"; writableRoots: readonly string[]; readableRoots: readonly string[];
  gitCommonDir: string; toolNetwork: boolean; environmentKeys: readonly string[];
}
export interface ProbeReport {
  profileHash: string; toolNetwork: boolean;
  results: ReadonlyArray<{ name: ProbeName; outcome: ProbeOutcome }>;
}
export function hashEnforcementProfile(profile: EnforcementProfile): string {
  return `sha256:${createHash("sha256").update(stableJson(profile)).digest("hex")}`;
}
export function decideProviderSupport(report: ProbeReport):
  | { supported: true }
  | { supported: false; code: "ENFORCEMENT_PROBE_FAILED"; failed: ProbeName[] } {
  const byName = new Map(report.results.map((result) => [result.name, result.outcome]));
  const failed = REQUIRED_PROBES.filter((name) => {
    const expected = name === "worktree-write" || (name === "tool-network-connect" && report.toolNetwork) ? "allowed" : "denied";
    return byName.get(name) !== expected;
  });
  return failed.length === 0 ? { supported: true } : { supported: false, code: "ENFORCEMENT_PROBE_FAILED", failed };
}
