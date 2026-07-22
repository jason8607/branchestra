import { execFile as nodeExecFile } from "node:child_process";

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export interface GitCommandRunnerOptions {
  executableRealpath?: "/usr/bin/git";
  execFile?: typeof nodeExecFile;
}

const GIT_ARGUMENT_PREFIX = [
  "-c", "user.name=Branchestra",
  "-c", "user.email=branchestra@localhost",
  "-c", "core.hooksPath=/dev/null"
] as const;

const GIT_ENVIRONMENT = Object.freeze({
  PATH: "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null"
});

export class GitCommandRunner {
  private readonly executable: "/usr/bin/git";
  private readonly execFile: typeof nodeExecFile;

  constructor(options: GitCommandRunnerOptions = {}) {
    this.executable = options.executableRealpath ?? "/usr/bin/git";
    this.execFile = options.execFile ?? nodeExecFile;
  }

  run(cwdRealpath: string, argv: readonly string[]): Promise<GitCommandResult> {
    return new Promise((resolve, reject) => {
      this.execFile(this.executable, [...GIT_ARGUMENT_PREFIX, "-C", cwdRealpath, ...argv], {
        shell: false,
        env: GIT_ENVIRONMENT,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024
      }, (error, stdout, stderr) => {
        if (error !== null) {
          reject(Object.assign(error, { stderr }));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }

  runBuffer(cwdRealpath: string, argv: readonly string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.execFile(this.executable, [...GIT_ARGUMENT_PREFIX, "-C", cwdRealpath, ...argv], {
        shell: false,
        env: GIT_ENVIRONMENT,
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024
      }, (error, stdout, stderr) => {
        if (error !== null) {
          reject(Object.assign(error, { stderr }));
          return;
        }
        resolve(stdout);
      });
    });
  }
}
