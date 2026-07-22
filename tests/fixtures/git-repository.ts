import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitRepositoryFixture {
  root: string;
  cleanup(): void;
}

export function createGitRepository(): GitRepositoryFixture {
  const root = mkdtempSync(join(tmpdir(), "branchestra-git-"));
  execFileSync("/usr/bin/git", ["init", "-b", "main", root]);
  writeFileSync(join(root, "README.md"), "# Fixture\n", "utf8");
  mkdirSync(join(root, "nested"));
  execFileSync("/usr/bin/git", ["-C", root, "add", "README.md"]);
  execFileSync("/usr/bin/git", [
    "-C", root,
    "-c", "user.name=Branchestra",
    "-c", "user.email=branchestra@invalid",
    "commit", "--no-gpg-sign", "-m", "Initial commit"
  ]);

  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    }
  };
}
