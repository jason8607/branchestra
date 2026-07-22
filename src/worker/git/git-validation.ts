const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BRANCH_REF_PATTERN = /^refs\/heads\/[A-Za-z0-9._/-]+$/;

export class GitValidationError extends Error {}

export function assertGitOid(oid: string): void {
  if (!OID_PATTERN.test(oid)) throw new GitValidationError("GIT_OID_INVALID");
}

export function assertBranchRef(ref: string): void {
  if (!BRANCH_REF_PATTERN.test(ref)) throw new GitValidationError("GIT_REF_INVALID");
  const suffix = ref.slice("refs/heads/".length);
  const components = suffix.split("/");
  if (suffix.includes("..")
    || suffix.includes("@{")
    || components.some((component) => component.length === 0
      || component.startsWith(".")
      || component.endsWith(".")
      || component.endsWith(".lock"))) {
    throw new GitValidationError("GIT_REF_INVALID");
  }
}
