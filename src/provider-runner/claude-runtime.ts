import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ProviderCapabilities } from "../shared/contracts/provider";
import type { ProviderRunnerMessage } from "../shared/contracts/provider-runner";
import type { ProviderRunnerRuntime } from "./runtime";
import type { ClaudeSdkFactory } from "./sdk-factories";

type StartCommand = Parameters<ProviderRunnerRuntime["start"]>[0];
type Emit = Parameters<ProviderRunnerRuntime["start"]>[1];

export const CLAUDE_CAPABILITIES = {
  interactiveApproval: true,
  protocolInterrupt: false,
  processAbort: true,
  textDeltaStreaming: true,
  itemEventStreaming: true,
  sessionResume: true,
  workspaceWriteSandbox: true,
  toolNetworkControl: true,
  contextTools: "mcp",
} as const satisfies ProviderCapabilities;

interface ToolClient {
  call(input: { runId: string; callId: string; request: { name: string; input: unknown } }): Promise<{ content: string; truncated: boolean }>;
}

const TOOL_SPECS = [
  ["context_search", "context.search", { query: z.string().min(1).max(500), limit: z.number().int().min(1).max(20).default(10) }],
  ["context_read", "context.read", { eventIds: z.array(z.string().min(1)).min(1).max(50) }],
  ["git_status", "git.status", {}],
  ["git_diff", "git.diff", { fromOid: z.string(), toOid: z.string().optional(), pathspec: z.array(z.string()).optional() }],
  ["git_show", "git.show", { checkpointOid: z.string(), path: z.string().optional() }],
  ["git_log", "git.log", { startOid: z.string(), maxCount: z.number().int().min(1).max(50).default(20) }],
] as const;

export function createClaudeRuntime(deps: { sdk: ClaudeSdkFactory; toolClient: ToolClient; now(): Date }): ProviderRunnerRuntime {
  let abortController: AbortController | null = null;
  let closeHandle: (() => void) | null = null;
  let closed = false;

  return {
    async start(command: StartCommand, emit: Emit): Promise<void> {
      if (command.provider !== "claude") throw new Error("Claude runtime received a non-Claude command");
      const sdk = await deps.sdk.load();
      abortController = new AbortController();
      closed = false;
      let providerSeq = 0;
      const tools = TOOL_SPECS.map(([sdkName, name, schema]) => sdk.tool(
        sdkName,
        `Branchestra read-only ${name}`,
        schema,
        async (input) => {
          const result = await deps.toolClient.call({ runId: command.runId, callId: randomUUID(), request: { name, input } });
          return { content: [{ type: "text", text: result.content }], isError: false };
        },
        { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
      ));
      const mcpServer = sdk.createSdkMcpServer({ name: "branchestra", version: "1.0.0", tools });
      const queryHandle = sdk.query({
        prompt: command.request.instruction,
        options: {
          abortController,
          pathToClaudeCodeExecutable: command.executableRealpath,
          cwd: command.request.worktreePath,
          env: command.request.environment,
          ...(command.type === "run.resume" ? { resume: command.providerSessionId } : {}),
          permissionMode: "default",
          allowDangerouslySkipPermissions: false,
          allowedTools: TOOL_SPECS.map(([name]) => `mcp__branchestra__${name}`),
          disallowedTools: ["Agent", "Task", "EnterWorktree", "ExitWorktree", "WebFetch", "WebSearch", "Bash(git *)"],
          canUseTool: async (toolName: string) => {
            if (toolName.startsWith("mcp__branchestra__")) return { behavior: "allow" as const };
            await emit({
              type: "provider.raw", runId: command.runId, providerSeq: providerSeq++, receivedAt: deps.now().toISOString(),
              payload: { type: "permission_denied", tool_name: toolName },
            });
            return { behavior: "deny" as const, message: "Outside Branchestra approval scope", interrupt: true };
          },
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            autoAllowBashIfSandboxed: false,
            allowUnsandboxedCommands: false,
            filesystem: { allowWrite: [command.request.approvedCapabilities.workspaceRootRealpath], denyWrite: command.request.deniedWriteRoots },
            network: {
              allowedDomains: command.request.approvedCapabilities.toolNetwork ? ["*"] : [],
              deniedDomains: command.request.approvedCapabilities.toolNetwork ? [] : ["*"],
              allowLocalBinding: false,
              allowUnixSockets: [],
              allowAllUnixSockets: false,
            },
          },
          mcpServers: { branchestra: mcpServer },
          strictMcpConfig: true,
          settingSources: [],
          additionalDirectories: [],
          persistSession: true,
          includePartialMessages: true,
        },
      });
      closeHandle = () => queryHandle.close();
      try {
        for await (const payload of queryHandle) {
          const message: ProviderRunnerMessage = { type: "provider.raw", runId: command.runId, providerSeq: providerSeq++, receivedAt: deps.now().toISOString(), payload };
          await emit(message);
        }
        await emit({ type: "run.completed", runId: command.runId });
      } catch (error) {
        if (abortController.signal.aborted) await emit({ type: "run.cancelled", runId: command.runId });
        else await emit({ type: "run.failed", runId: command.runId, code: "provider_error", message: error instanceof Error ? error.message : String(error) });
      }
    },
    async cancel(): Promise<void> {
      abortController?.abort();
      if (!closed) {
        closed = true;
        closeHandle?.();
      }
    },
    async close(): Promise<void> {
      await this.cancel("quit");
    },
  };
}
