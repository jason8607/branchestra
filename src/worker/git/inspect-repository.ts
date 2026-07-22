import type { execFile as nodeExecFile } from "node:child_process";
import { realpath as nodeRealpath } from "node:fs/promises";
import type { ExecFileRunner } from "../process/exec-file";
import { GitCommandRunner, type GitCommandResult } from "./git-command-runner";
import { assertGitOid } from "./git-validation";

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

function removeGitLineTerminator(output: string): string {
  if (output.endsWith("\r\n")) return output.slice(0, -2);
  if (output.endsWith("\n")) return output.slice(0, -1);
  return output;
}

export async function inspectExistingRepository(
  selectedPath: string,
  dependencies?: RepositoryInspectorDependencies
): Promise<RepositoryInspection> {
  try {
    const canonicalize = dependencies?.realpath ?? nodeRealpath;
    if (dependencies?.gitExecutable !== undefined && dependencies.gitExecutable !== "/usr/bin/git") {
      throw new Error("Git executable must be /usr/bin/git");
    }
    const compatibilityExecFile = dependencies === undefined ? undefined : ((
      executable: string,
      argv: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      const cwdIndex = argv.indexOf("-C");
      if (cwdIndex === -1) {
        callback(new Error("Git runner omitted -C"), "", "");
        return undefined;
      }
      void dependencies.execFile(executable, argv.slice(cwdIndex), {
        timeoutMs: 5_000,
        maxBufferBytes: 1_048_576
      }).then(
        (result: GitCommandResult) => callback(null, result.stdout, result.stderr),
        (error: unknown) => {
          const failure = error instanceof Error ? error : new Error("Git execution failed");
          const stderr = "stderr" in failure && typeof failure.stderr === "string" ? failure.stderr : "";
          callback(failure, "", stderr);
        }
      );
      return undefined;
    }) as unknown as typeof nodeExecFile;
    const git = new GitCommandRunner(compatibilityExecFile === undefined ? {} : { execFile: compatibilityExecFile });
    const selected = await canonicalize(selectedPath);
    const runGit = async (cwd: string, args: readonly string[]): Promise<string> => (
      removeGitLineTerminator((await git.run(cwd, args)).stdout)
    );
    const repositoryRootOutput = await runGit(selected, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
    const repositoryRoot = await canonicalize(repositoryRootOutput);
    const gitCommonDirOutput = await runGit(repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const gitCommonDir = await canonicalize(gitCommonDirOutput);
    const headOid = await runGit(repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
    const branch = await runGit(repositoryRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
    assertGitOid(headOid);
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
