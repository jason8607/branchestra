import { expect, it } from "vitest";
import { decideProviderSupport } from "../../src/worker/security/enforcement-profile";

it("does not start a provider when one required negative probe is missing or failed", () => {
  const decision = decideProviderSupport({ profileHash: "sha256:profile", toolNetwork: false, results: [
    { name: "worktree-write", outcome: "allowed" }, { name: "parent-traversal", outcome: "denied" },
    { name: "symlink-outside-write", outcome: "denied" }, { name: "git-common-dir-write", outcome: "allowed" },
    { name: "other-ref-write", outcome: "denied" }, { name: "child-outside-write", outcome: "denied" },
    { name: "credential-env-read", outcome: "denied" }, { name: "tool-network-connect", outcome: "denied" },
  ] });
  expect(decision).toEqual({ supported: false, code: "ENFORCEMENT_PROBE_FAILED", failed: ["git-common-dir-write"] });
});
