import { ReadOnlyToolRequestSchema } from "./tool-schemas";
import type { ReadOnlyToolBinding, ReadOnlyToolResult, ReadOnlyToolService } from "./read-only-tool-service";

export interface ToolCall { callId: string; runId: string; request: unknown }
export interface ToolReply extends ReadOnlyToolResult { callId: string }

export class ToolBridge {
  constructor(
    private readonly service: ReadOnlyToolService,
    private readonly bindingForRun: (runId: string) => Promise<ReadOnlyToolBinding> | ReadOnlyToolBinding,
  ) {}

  async handle(call: ToolCall): Promise<ToolReply> {
    if (!call.callId) throw new Error("Tool call ID is required");
    const request = ReadOnlyToolRequestSchema.parse(call.request);
    const binding = await this.bindingForRun(call.runId);
    return { callId: call.callId, ...await this.service.execute(binding, request) };
  }
}
