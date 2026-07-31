import { z } from "zod";
import type { ProviderEvent } from "../../../shared/contracts/provider";

type Run = { runId: string; providerSeq: number; occurredAt: string };
const envelope = z.object({ type: z.string() }).passthrough();

export function normalizeClaudeEvent(raw: unknown, run: Run): ProviderEvent[] {
  const value = envelope.parse(raw);
  const base = { ...run, provider: "claude" as const };
  if (value.type === "system" && value.subtype === "init") {
    const sessionId = z.string().min(1).safeParse(value.session_id);
    if (!sessionId.success) throw new Error("Claude init is missing session_id");
    return [{ ...base, type: "session.started", sessionId: sessionId.data }];
  }
  if (value.type === "assistant") {
    const message = z.object({ id: z.string().min(1), content: z.array(z.object({ type: z.string() }).passthrough()) }).passthrough().parse(value.message);
    const text = message.content.filter((block) => block.type === "text").map((block) => typeof block.text === "string" ? block.text : "").join("");
    const events: ProviderEvent[] = [];
    if (text) events.push({ ...base, type: "assistant.completed", messageId: message.id, text });
    for (const block of message.content) {
      if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        events.push({ ...base, type: "tool.started", toolCallId: block.id, toolName: block.name, summary: `Claude requested ${block.name}` });
      }
    }
    return events;
  }
  if (value.type === "stream_event") {
    const event = z.object({ type: z.literal("content_block_delta"), delta: z.object({ type: z.literal("text_delta"), text: z.string() }).passthrough() }).passthrough().safeParse(value.event);
    if (!event.success || typeof value.uuid !== "string") return [];
    return [{ ...base, type: "assistant.delta", messageId: value.uuid, text: event.data.delta.text }];
  }
  if (value.type === "result") {
    const session = z.string().min(1).safeParse(value.session_id);
    if (!session.success) throw new Error("Claude result is missing session_id");
    const events: ProviderEvent[] = [{ ...base, type: "session.started", sessionId: session.data }];
    if (value.usage && typeof value.usage === "object") {
      const usage = value.usage as Record<string, unknown>;
      events.push({ ...base, type: "usage",
        ...(Number.isInteger(usage.input_tokens) ? { inputTokens: Number(usage.input_tokens) } : {}),
        ...(Number.isInteger(usage.cache_read_input_tokens) ? { cachedInputTokens: Number(usage.cache_read_input_tokens) } : {}),
        ...(Number.isInteger(usage.output_tokens) ? { outputTokens: Number(usage.output_tokens) } : {}),
      });
    }
    if (value.is_error === true || value.subtype === "error") {
      events.push({ ...base, type: "run.failed", code: "provider_error", message: typeof value.result === "string" ? value.result : "Claude run failed", retryable: false });
    } else {
      events.push({ ...base, type: "run.completed", result: typeof value.result === "string" ? value.result : "" });
    }
    return events;
  }
  if (value.type === "permission_denied") {
    return [
      { ...base, type: "approval.required", capability: typeof value.tool_name === "string" ? value.tool_name : "provider.tool", reason: "Outside Branchestra approval scope", resumeStrategy: "next_run" },
      { ...base, type: "run.failed", code: "permission_denied", message: "Outside Branchestra approval scope", retryable: true },
    ];
  }
  return [];
}
