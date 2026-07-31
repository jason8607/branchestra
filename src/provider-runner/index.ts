import { createInterface } from "node:readline";
import { ProviderRunnerCommandSchema, type ProviderRunnerMessage } from "../shared/contracts/provider-runner";
import { createClaudeRuntime } from "./claude-runtime";
import { createCodexRuntime } from "./codex-runtime";
import { decodeJsonLine, writeJsonLine } from "./jsonl-channel";
import type { ProviderRunnerRuntime } from "./runtime";
import { loadClaudeSdkFactory, loadCodexSdkFactory } from "./sdk-factories";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const runId = argument("--branchestra-run-id");
const executableRealpath = argument("--branchestra-provider-executable-realpath");
if (!/^[0-9a-f-]{36}$/i.test(runId) || !executableRealpath.startsWith("/")) throw new Error("Invalid Provider runner identity");

const pendingTools = new Map<string, ReturnType<typeof Promise.withResolvers<{ content: string; truncated: boolean }>>>();
const emit = (message: ProviderRunnerMessage) => writeJsonLine(process.stdout, message);
let runtime: ProviderRunnerRuntime | null = null;
let activeRun: Promise<void> | null = null;

await emit({ type: "runner.ready", runId, pid: process.pid });
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
try {
  for await (const line of lines) {
    const command = decodeJsonLine(line, ProviderRunnerCommandSchema);
    if (command.runId !== runId) throw new Error("Provider runner run ID mismatch");
    if ((command.type === "run.start" || command.type === "run.resume") && command.executableRealpath !== executableRealpath) {
      throw new Error("Provider runner executable mismatch");
    }
    if (command.type === "tool.result") {
      const deferred = pendingTools.get(command.callId);
      if (!deferred) throw new Error("Unknown Provider tool result");
      pendingTools.delete(command.callId);
      deferred.resolve(command.result);
      continue;
    }
    if (command.type === "run.cancel") {
      await runtime?.cancel(command.reason);
      continue;
    }
    if (activeRun) throw new Error("Provider runner accepts one run command");
    runtime = command.provider === "claude"
      ? createClaudeRuntime({
          sdk: loadClaudeSdkFactory(),
          now: () => new Date(),
          toolClient: {
            async call(input) {
              const deferred = Promise.withResolvers<{ content: string; truncated: boolean }>();
              pendingTools.set(input.callId, deferred);
              await emit({ type: "tool.call", runId: input.runId, callId: input.callId, request: input.request });
              return deferred.promise;
            },
          },
        })
      : createCodexRuntime({ sdk: await loadCodexSdkFactory(), now: () => new Date() });
    activeRun = runtime.start(command, emit).finally(() => lines.close());
  }
  await activeRun;
} finally {
  await runtime?.close();
  for (const deferred of pendingTools.values()) deferred.reject(new Error("Provider runner closed"));
  pendingTools.clear();
}
