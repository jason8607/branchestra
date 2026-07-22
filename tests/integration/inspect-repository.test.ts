import { realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitRepository } from "../fixtures/git-repository";
import { inspectExistingRepository } from "../../src/worker/git/inspect-repository";

describe("real Git repository inspection", () => {
  it("accepts a subdirectory and returns canonical repository facts", async () => {
    const fixture = createGitRepository();
    try {
      const result = await inspectExistingRepository(join(fixture.root, "nested"));
      expect(result.repositoryRoot).toBe(realpathSync(fixture.root));
      expect(result.gitCommonDir).toBe(realpathSync(join(fixture.root, ".git")));
      expect(result.headOid).toMatch(/^[0-9a-f]{40,64}$/);
      expect(result.defaultBranch).toBe("main");
    } finally {
      fixture.cleanup();
    }
  });
});
