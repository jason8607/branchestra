import { createInterface } from "node:readline";
import { ProviderRunnerMessageSchema } from "../../shared/contracts/provider-runner";
import type { RunnerPort } from "../providers/runner-backed-adapter";
import type { ProviderProcessSupervisor } from "./provider-process-supervisor";

export class SupervisedProviderRunner implements RunnerPort {
  constructor(private readonly deps: {
    supervisor: ProviderProcessSupervisor;
    runnerEntryRealpath: string;
    workerGeneration: string;
    recordIntent(input: { runId: string; taskId: string; provider: "claude" | "codex"; worktreePath: string; executableRealpath: string }): void;
  }) {}

  async launch(input: Parameters<RunnerPort["launch"]>[0], accept: Parameters<RunnerPort["launch"]>[1]) {
    this.deps.recordIntent(input);
    const process = await this.deps.supervisor.spawn({
      runId: input.runId,
      workerGeneration: this.deps.workerGeneration,
      runnerEntryRealpath: this.deps.runnerEntryRealpath,
      providerExecutableRealpath: input.executableRealpath,
      env: input.environment,
    });
    const ready = Promise.withResolvers<void>();
    let readySeen = false;
    const lines = createInterface({ input: process.child.stdout, crlfDelay: Infinity });
    void (async () => {
      try {
        for await (const line of lines) {
          const message = ProviderRunnerMessageSchema.parse(JSON.parse(line));
          await accept(message);
          if (message.type === "runner.ready") {
            readySeen = true;
            ready.resolve();
          }
        }
        if (!readySeen) ready.reject(new Error("Provider runner exited before ready"));
      } catch (error) {
        ready.reject(error);
        try {
          await this.deps.supervisor.cancel(input.runId, "timeout");
        } catch {
          process.child.kill("SIGKILL");
        }
      }
    })();
    process.child.stderr.resume();
    await ready.promise;
    return {
      send: process.transport.send,
      cancel: (reason: "user" | "quit" | "timeout") => this.deps.supervisor.cancel(input.runId, reason),
    };
  }
}
