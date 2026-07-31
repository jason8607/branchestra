export interface ProviderProcessIdentity {
  runId: string; pid: number; pgid: number; runnerExecutableRealpath: string;
  providerExecutableRealpath: string; startToken: string; workerGeneration: string;
}
export function identitiesMatch(expected: ProviderProcessIdentity, observed: ProviderProcessIdentity): boolean {
  return expected.runId === observed.runId && expected.pid === observed.pid && expected.pgid === observed.pgid
    && expected.pid === expected.pgid && expected.runnerExecutableRealpath === observed.runnerExecutableRealpath
    && expected.providerExecutableRealpath === observed.providerExecutableRealpath
    && expected.startToken === observed.startToken && expected.workerGeneration === observed.workerGeneration;
}

export interface ProcessIdentityExecPort {
  (executable: string, args: readonly string[], options: { timeoutMs: number; maxBufferBytes: number; env: Record<string, string> }): Promise<{ stdout: string; stderr: string }>;
}

export class ProcessIdentityProbe {
  constructor(private readonly exec: ProcessIdentityExecPort) {}
  async read(pid: number, expectedRunId: string, providerExecutableRealpath: string, workerGeneration: string): Promise<ProviderProcessIdentity> {
    const result = await this.exec("/bin/ps", ["-o", "pid=,pgid=,lstart=,command=", "-p", String(pid)], {
      timeoutMs: 2_000, maxBufferBytes: 65_536, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    });
    const match = /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/m.exec(result.stdout);
    if (!match) throw new Error("Provider process identity could not be observed");
    const observedPid = Number(match[1]);
    const pgid = Number(match[2]);
    const command = match[4]!;
    const runPair = `--branchestra-run-id ${expectedRunId}`;
    const executablePair = `--branchestra-provider-executable-realpath ${providerExecutableRealpath}`;
    if (observedPid !== pid || pid !== pgid || !command.includes(runPair) || !command.includes(executablePair)) {
      throw new Error("Provider process identity no longer matches journal");
    }
    return {
      runId: expectedRunId, pid, pgid, runnerExecutableRealpath: process.execPath,
      providerExecutableRealpath, startToken: match[3]!, workerGeneration,
    };
  }
  async verify(expected: ProviderProcessIdentity): Promise<void> {
    const observed = await this.read(expected.pid, expected.runId, expected.providerExecutableRealpath, expected.workerGeneration);
    if (!identitiesMatch(expected, observed)) throw new Error("Provider process identity no longer matches journal");
  }
}
