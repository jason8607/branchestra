const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BRANCH_REF_PATTERN = /^refs\/heads\/[A-Za-z0-9._/-]+$/;
const BRANCH_PREFIX = "refs/heads/";
const GIT_FORBIDDEN_REF_CHARACTER = /[~^:?*[\]\\]/;

export class GitValidationError extends Error {}

export function assertGitOid(oid: string): void {
  if (!OID_PATTERN.test(oid)) throw new GitValidationError("GIT_OID_INVALID");
}

export function assertBranchRef(ref: string): void {
  if (!ref.startsWith(BRANCH_PREFIX)) throw new GitValidationError("GIT_REF_INVALID");
  const suffix = ref.slice(BRANCH_PREFIX.length);
  const components = suffix.split("/");
  if (suffix.length === 0
    || [...suffix].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x20 || codePoint === 0x7f;
    })
    || GIT_FORBIDDEN_REF_CHARACTER.test(suffix)
    || suffix.includes("..")
    || suffix.includes("@{")
    || components.some((component) => component.length === 0
      || component.startsWith(".")
      || component.endsWith(".")
      || component.endsWith(".lock"))) {
    throw new GitValidationError("GIT_REF_INVALID");
  }
  if (!BRANCH_REF_PATTERN.test(ref)) throw new GitValidationError("GIT_REF_UNSUPPORTED");
}

export function assertBranchName(branch: string): void {
  assertBranchRef(`${BRANCH_PREFIX}${branch}`);
}
