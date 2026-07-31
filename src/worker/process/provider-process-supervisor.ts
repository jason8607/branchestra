import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname } from "node:path";
import type { ProviderRunnerCommand } from "../../shared/contracts/provider-runner";
import type { ProviderProcessIdentity, ProcessIdentityProbe } from "./process-identity";

type CancelReason = "user" | "quit" | "timeout";
export interface ActiveProviderProcess {
  runId: string; pgid: number; identity: ProviderProcessIdentity; child: ChildProcessWithoutNullStreams;
  transport: { send(command: ProviderRunnerCommand): Promise<void> };
  exited: Promise<void>;
}
export interface ProviderProcessSupervisorDependencies {
  probe: Pick<ProcessIdentityProbe, "read" | "verify">;
  journal: {
    recordProviderIdentity(runId: string, identity: ProviderProcessIdentity, at: string): Promise<void> | void;
    recordProviderSignal(runId: string, signal: "abort" | "SIGTERM" | "SIGKILL", at: string): Promise<void> | void;
    completeProviderProcess(runId: string, at: string): Promise<void> | void;
  };
  now(): string;
  config?: { abortGraceMs: number; termGraceMs: number; killWaitMs: number };
  killGroup?: (pgid: number, signal: NodeJS.Signals) => void;
}

export class ProviderProcessSupervisor {
  private readonly active = new Map<string, ActiveProviderProcess>();
  private readonly config;
  constructor(private readonly deps: ProviderProcessSupervisorDependencies) {
    this.config = deps.config ?? { abortGraceMs: 3_000, termGraceMs: 2_000, killWaitMs: 1_000 };
  }

  async spawn(input: { runId: string; workerGeneration: string; runnerEntryRealpath: string; providerExecutableRealpath: string; env: Record<string, string> }): Promise<ActiveProviderProcess> {
    if (this.active.has(input.runId)) throw new Error("Provider run is already active");
    const child = spawn(process.execPath, [input.runnerEntryRealpath, "--branchestra-run-id", input.runId, "--branchestra-provider-executable-realpath", input.providerExecutableRealpath], {
      cwd: dirname(input.runnerEntryRealpath), detached: true, env: { ...input.env, ELECTRON_RUN_AS_NODE: "1" }, shell: false, stdio: ["pipe", "pipe", "pipe"],
    });
    if (!child.pid) throw new Error("Provider runner did not expose a PID");
    let identity: ProviderProcessIdentity;
    try {
      identity = await this.deps.probe.read(child.pid, input.runId, input.providerExecutableRealpath, input.workerGeneration);
    } catch (error) {
      child.kill("SIGKILL");
      throw error;
    }
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const transport = { send: async (command: ProviderRunnerCommand) => {
      const line = `${JSON.stringify(command)}\n`;
      if (child.stdin.write(line)) return;
      await new Promise<void>((resolve, reject) => { child.stdin.once("drain", resolve); child.stdin.once("error", reject); });
    } };
    const active = { runId: input.runId, pgid: identity.pgid, identity, child, transport, exited };
    this.active.set(input.runId, active);
    await this.deps.journal.recordProviderIdentity(input.runId, identity, this.deps.now());
    void exited.then(() => this.complete(active));
    return active;
  }

  async cancel(runId: string, reason: CancelReason): Promise<void> {
    const active = this.active.get(runId);
    if (!active) throw new Error(`Provider run is not active: ${runId}`);
    await active.transport.send({ type: "run.cancel", runId, reason, deadlineAt: new Date(Date.parse(this.deps.now()) + this.config.abortGraceMs).toISOString() });
    await this.deps.journal.recordProviderSignal(runId, "abort", this.deps.now());
    if (await this.waitForExit(active, this.config.abortGraceMs)) return this.complete(active);
    await this.deps.probe.verify(active.identity);
    (this.deps.killGroup ?? ((pgid, signal) => process.kill(-pgid, signal)))(active.identity.pgid, "SIGTERM");
    await this.deps.journal.recordProviderSignal(runId, "SIGTERM", this.deps.now());
    if (await this.waitForExit(active, this.config.termGraceMs)) return this.complete(active);
    await this.deps.probe.verify(active.identity);
    (this.deps.killGroup ?? ((pgid, signal) => process.kill(-pgid, signal)))(active.identity.pgid, "SIGKILL");
    await this.deps.journal.recordProviderSignal(runId, "SIGKILL", this.deps.now());
    await this.waitForExit(active, this.config.killWaitMs);
    await this.complete(active);
  }

  private async waitForExit(active: ActiveProviderProcess, ms: number): Promise<boolean> {
    return Promise.race([active.exited.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), ms))]);
  }
  private async complete(active: ActiveProviderProcess): Promise<void> {
    if (this.active.get(active.runId) !== active) return;
    this.active.delete(active.runId);
    await this.deps.journal.completeProviderProcess(active.runId, this.deps.now());
  }
}
