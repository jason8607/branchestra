import type { ProviderRunnerCommand, ProviderRunnerMessage } from "../shared/contracts/provider-runner";

export interface ProviderRunnerRuntime {
  start(command: Extract<ProviderRunnerCommand, { type: "run.start" | "run.resume" }>, emit: (message: ProviderRunnerMessage) => Promise<void>): Promise<void>;
  cancel(reason: "user" | "quit" | "timeout"): Promise<void>;
  close(): Promise<void>;
}
