import { execFile as nodeExecFile } from "node:child_process";

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export interface GitCommandRunnerOptions {
  executableRealpath?: "/usr/bin/git";
  execFile?: typeof nodeExecFile;
  timeoutMs?: number;
}

const GIT_ARGUMENT_PREFIX = [
  "--no-pager",
  "-c", "user.name=Branchestra",
  "-c", "user.email=branchestra@localhost",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "log.showSignature=false"
] as const;

const GIT_ENVIRONMENT = Object.freeze({
  PATH: "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0"
});

const DEFAULT_TIMEOUT_MS = 15_000;

export class GitCommandRunner {
  private readonly executable: "/usr/bin/git";
  private readonly execFile: typeof nodeExecFile;
  private readonly timeoutMs: number;

  constructor(options: GitCommandRunnerOptions = {}) {
    this.executable = options.executableRealpath ?? "/usr/bin/git";
    this.execFile = options.execFile ?? nodeExecFile;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) {
      throw new RangeError("Git timeout must be an integer from 1 through 60000 milliseconds");
    }
  }

  run(cwdRealpath: string, argv: readonly string[]): Promise<GitCommandResult> {
    return new Promise((resolve, reject) => {
      this.execFile(this.executable, [...GIT_ARGUMENT_PREFIX, "-C", cwdRealpath, ...argv], {
        shell: false,
        env: GIT_ENVIRONMENT,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: this.timeoutMs,
        killSignal: "SIGKILL"
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
        maxBuffer: 64 * 1024 * 1024,
        timeout: this.timeoutMs,
        killSignal: "SIGKILL"
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
