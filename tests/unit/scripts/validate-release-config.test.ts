import { expect, it } from "vitest";
import { validateReleaseConfig } from "../../../scripts/validate-release-config.mjs";

it("requires a stable reverse-DNS bundle id and repository owner", () => {
  expect(() => validateReleaseConfig({ BRANCHESTRA_BUNDLE_ID: "", BRANCHESTRA_GITHUB_OWNER: "" })).toThrow("BRANCHESTRA_BUNDLE_ID must be a controlled reverse-DNS identifier");
  expect(validateReleaseConfig({ BRANCHESTRA_BUNDLE_ID: "com.example.branchestra", BRANCHESTRA_GITHUB_OWNER: "example" }))
    .toEqual({ bundleId: "com.example.branchestra", githubOwner: "example" });
});
