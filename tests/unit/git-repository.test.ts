import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createGitRepository,
  type GitRepositoryFixture
} from "../fixtures/git-repository";

describe("createGitRepository", () => {
  it("removes its generated root when setup fails", () => {
    const failure = new Error("fixture setup failed");
    let generatedRoot = "";
    let returnedFixture: GitRepositoryFixture | undefined;

    try {
      returnedFixture = createGitRepository({
        runGit(args) {
          generatedRoot = args.at(-1) ?? "";
          throw failure;
        }
      });
      throw new Error("fixture creation should have failed");
    } catch (error) {
      expect(error).toBe(failure);
    } finally {
      returnedFixture?.cleanup();
    }

    expect(generatedRoot).not.toBe("");
    expect(existsSync(generatedRoot)).toBe(false);
  });
});
