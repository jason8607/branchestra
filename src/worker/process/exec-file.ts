import { execFile } from "node:child_process";

export interface ExecFileOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  maxBufferBytes: number;
}

export interface ExecFileResult {
  stdout: string;
  stderr: string;
}

export type ExecFileRunner = (
  executable: string,
  args: readonly string[],
  options: ExecFileOptions
) => Promise<ExecFileResult>;

export const execFileNoShell: ExecFileRunner = (executable, args, options) => new Promise((resolve, reject) => {
  execFile(executable, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: options.maxBufferBytes,
    windowsHide: true,
    shell: false
  }, (error, stdout, stderr) => {
    if (error) {
      reject(Object.assign(new Error(`Executable failed: ${executable}`), { cause: error, stderr }));
      return;
    }
    resolve({ stdout, stderr });
  });
});
