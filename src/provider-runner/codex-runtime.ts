import type { ProviderCapabilities } from "../shared/contracts/provider";
import type { ProviderRunnerMessage } from "../shared/contracts/provider-runner";
import type { ProviderRunnerRuntime } from "./runtime";
import type { CodexSdkFactory } from "./sdk-factories";

type StartCommand = Parameters<ProviderRunnerRuntime["start"]>[0];
type Emit = Parameters<ProviderRunnerRuntime["start"]>[1];

export const CODEX_CAPABILITIES = {
  interactiveApproval: false,
  protocolInterrupt: false,
  processAbort: true,
  textDeltaStreaming: false,
  itemEventStreaming: true,
  sessionResume: true,
  workspaceWriteSandbox: true,
  toolNetworkControl: true,
  contextTools: "injected",
} as const satisfies ProviderCapabilities;

export function createCodexRuntime(deps: { sdk: CodexSdkFactory; now(): Date; contextSnapshot?(command: StartCommand): string }): ProviderRunnerRuntime {
  let controller: AbortController | null = null;
  return {
    async start(command: StartCommand, emit: Emit): Promise<void> {
      if (command.provider !== "codex" || !command.codexConfigLockRealpath) throw new Error("Codex runtime requires a reviewed config lock");
      controller = new AbortController();
      const client = deps.sdk.create({ codexPathOverride: command.executableRealpath, env: command.request.environment, codexConfigLockRealpath: command.codexConfigLockRealpath });
      const options = {
        workingDirectory: command.request.worktreePath,
        sandboxMode: "workspace-write" as const,
        approvalPolicy: "never" as const,
        networkAccessEnabled: command.request.approvedCapabilities.toolNetwork,
        webSearchMode: "disabled" as const,
        webSearchEnabled: false,
        additionalDirectories: [],
      };
      const thread = command.type === "run.resume" ? client.resumeThread(command.providerSessionId, options) : client.startThread(options);
      const snapshot = deps.contextSnapshot?.(command);
      const input = snapshot ? `READ-ONLY BRANCHESTRA SNAPSHOT\n${snapshot}\n\n${command.request.instruction}` : command.request.instruction;
      let providerSeq = 0;
      try {
        const stream = await thread.runStreamed(input, { signal: controller.signal });
        for await (const payload of stream.events) {
          const message: ProviderRunnerMessage = { type: "provider.raw", runId: command.runId, providerSeq: providerSeq++, receivedAt: deps.now().toISOString(), payload };
          await emit(message);
        }
        await emit({ type: "run.completed", runId: command.runId });
      } catch (error) {
        if (controller.signal.aborted) await emit({ type: "run.cancelled", runId: command.runId });
        else await emit({ type: "run.failed", runId: command.runId, code: "provider_error", message: error instanceof Error ? error.message : String(error) });
      }
    },
    async cancel(): Promise<void> { controller?.abort(); },
    async close(): Promise<void> { controller?.abort(); },
  };
}
