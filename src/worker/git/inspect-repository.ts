import { realpath as nodeRealpath } from "node:fs/promises";
import { execFileNoShell, type ExecFileRunner } from "../process/exec-file";

export interface RepositoryInspection {
  repositoryRoot: string;
  gitCommonDir: string;
  headOid: string;
  defaultBranch: string | null;
}

export interface RepositoryInspectorDependencies {
  execFile: ExecFileRunner;
  realpath(path: string): Promise<string>;
  gitExecutable: string;
}

export class GitRepositoryError extends Error {}

const productionDependencies: RepositoryInspectorDependencies = {
  execFile: execFileNoShell,
  realpath: nodeRealpath,
  gitExecutable: "/usr/bin/git"
};

export async function inspectExistingRepository(
  selectedPath: string,
  dependencies: RepositoryInspectorDependencies = productionDependencies
): Promise<RepositoryInspection> {
  try {
    const selected = await dependencies.realpath(selectedPath);
    const run = async (args: readonly string[]): Promise<string> => (
      await dependencies.execFile(dependencies.gitExecutable, args, {
        timeoutMs: 5_000,
        maxBufferBytes: 1_048_576
      })
    ).stdout.trim();
    const repositoryRootOutput = await run(["-C", selected, "rev-parse", "--path-format=absolute", "--show-toplevel"]);
    const repositoryRoot = await dependencies.realpath(repositoryRootOutput);
    const gitCommonDirOutput = await run(["-C", repositoryRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const gitCommonDir = await dependencies.realpath(gitCommonDirOutput);
    const headOid = await run(["-C", repositoryRoot, "rev-parse", "--verify", "HEAD^{commit}"]);
    const branch = await run(["-C", repositoryRoot, "rev-parse", "--abbrev-ref", "HEAD"]);
    if (!/^[0-9a-f]{40,64}$/.test(headOid)) throw new Error("HEAD is not a commit OID");
    return {
      repositoryRoot,
      gitCommonDir,
      headOid,
      defaultBranch: branch === "HEAD" ? null : branch
    };
  } catch (error) {
    throw new GitRepositoryError(
      "Selected directory is not a Git repository with a valid HEAD",
      { cause: error }
    );
  }
}
