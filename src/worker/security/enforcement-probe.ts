import { dirname, join, resolve } from "node:path";
import { hashEnforcementProfile, REQUIRED_PROBES, type EnforcementProfile, type ProbeName, type ProbeOutcome, type ProbeReport } from "./enforcement-profile";

export interface EnforcementProbeAttempt {
  name: ProbeName;
  operation: "write" | "env" | "connect";
  target: string;
  expected: ProbeOutcome;
}
export async function runEnforcementProbe(profile: EnforcementProfile, deps: {
  attempt(input: EnforcementProbeAttempt): Promise<ProbeOutcome>;
  nonce(): string;
}): Promise<ProbeReport> {
  const worktree = profile.writableRoots[0];
  if (!worktree || !resolve(worktree).startsWith("/")) throw new Error("Enforcement profile requires a canonical writable root");
  const parent = dirname(worktree);
  const attempts: Record<ProbeName, Omit<EnforcementProbeAttempt, "name">> = {
    "worktree-write": { operation: "write", target: join(worktree, `.branchestra-probe-${deps.nonce()}`), expected: "allowed" },
    "parent-traversal": { operation: "write", target: join(parent, `.branchestra-probe-${deps.nonce()}`), expected: "denied" },
    "symlink-outside-write": { operation: "write", target: join(worktree, ".branchestra-outside-link", deps.nonce()), expected: "denied" },
    "git-common-dir-write": { operation: "write", target: join(profile.gitCommonDir, `.branchestra-probe-${deps.nonce()}`), expected: "denied" },
    "other-ref-write": { operation: "write", target: join(profile.gitCommonDir, "refs", "heads", `branchestra-probe-${deps.nonce()}`), expected: "denied" },
    "child-outside-write": { operation: "write", target: join(parent, `child-${deps.nonce()}`, "probe"), expected: "denied" },
    "credential-env-read": { operation: "env", target: "sensitive-environment-keys", expected: "denied" },
    "tool-network-connect": { operation: "connect", target: "127.0.0.1:9", expected: profile.toolNetwork ? "allowed" : "denied" },
  };
  const results = [] as Array<{ name: ProbeName; outcome: ProbeOutcome }>;
  for (const name of REQUIRED_PROBES) results.push({ name, outcome: await deps.attempt({ name, ...attempts[name] }) });
  return { profileHash: hashEnforcementProfile(profile), toolNetwork: profile.toolNetwork, results };
}
