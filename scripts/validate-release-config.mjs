export function validateReleaseConfig(env) {
  const bundleId = env.BRANCHESTRA_BUNDLE_ID ?? "";
  if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*){2,}$/i.test(bundleId)) throw new Error("BRANCHESTRA_BUNDLE_ID must be a controlled reverse-DNS identifier");
  const githubOwner = env.BRANCHESTRA_GITHUB_OWNER ?? "";
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(githubOwner)) throw new Error("BRANCHESTRA_GITHUB_OWNER must be a GitHub owner name");
  return { bundleId, githubOwner };
}
