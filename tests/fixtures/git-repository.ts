import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitRepositoryFixture {
  root: string;
  cleanup(): void;
}

export interface GitRepositoryFixtureDependencies {
  runGit?(args: readonly string[]): void;
}

const runGitWithExecFile = (args: readonly string[]): void => {
  execFileSync("/usr/bin/git", [...args]);
};

export function createGitRepository(
  dependencies: GitRepositoryFixtureDependencies = {}
): GitRepositoryFixture {
  const root = mkdtempSync(join(tmpdir(), "branchestra-git-"));
  try {
    const runGit = dependencies.runGit ?? runGitWithExecFile;
    runGit(["init", "-b", "main", root]);
    writeFileSync(join(root, "README.md"), "# Fixture\n", "utf8");
    mkdirSync(join(root, "nested"));
    runGit(["-C", root, "add", "README.md"]);
    runGit([
      "-C", root,
      "-c", "user.name=Branchestra",
      "-c", "user.email=branchestra@invalid",
      "commit", "--no-gpg-sign", "-m", "Initial commit"
    ]);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }

  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    }
  };
}
