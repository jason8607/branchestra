export interface ProviderExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  maxBufferBytes: number;
}
export type ProviderExecPort = (
  executable: string,
  args: readonly string[],
  options: ProviderExecOptions,
) => Promise<{ stdout: string; stderr: string }>;
