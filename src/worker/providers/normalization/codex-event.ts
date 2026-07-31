import { z } from "zod";
import type { ProviderEvent } from "../../../shared/contracts/provider";

type Run = { runId: string; providerSeq: number; occurredAt: string };
const envelope = z.object({ type: z.string() }).passthrough();

export function normalizeCodexEvent(raw: unknown, run: Run): ProviderEvent[] {
  const value = envelope.parse(raw);
  const base = { ...run, provider: "codex" as const };
  if (value.type === "thread.started") {
    const id = z.string().min(1).safeParse(value.thread_id);
    if (!id.success) throw new Error("Codex thread.started is missing thread_id");
    return [{ ...base, type: "session.started", sessionId: id.data }];
  }
  if (value.type === "item.started" || value.type === "item.updated" || value.type === "item.completed") {
    const item = z.object({ id: z.string().min(1), type: z.string().min(1) }).passthrough().parse(value.item);
    const status = value.type === "item.started" ? "started" as const : value.type === "item.updated" ? "updated" as const : "completed" as const;
    const summary = typeof item.text === "string" ? item.text : typeof item.command === "string" ? item.command : item.type;
    return [{ ...base, type: "item.snapshot", itemId: item.id, itemType: item.type, status, summary }];
  }
  if (value.type === "turn.completed") {
    const usage = value.usage && typeof value.usage === "object" ? value.usage as Record<string, unknown> : {};
    return [
      { ...base, type: "usage",
        ...(Number.isInteger(usage.input_tokens) ? { inputTokens: Number(usage.input_tokens) } : {}),
        ...(Number.isInteger(usage.cached_input_tokens) ? { cachedInputTokens: Number(usage.cached_input_tokens) } : {}),
        ...(Number.isInteger(usage.output_tokens) ? { outputTokens: Number(usage.output_tokens) } : {}),
      },
      { ...base, type: "run.completed", result: "Codex turn completed" },
    ];
  }
  if (value.type === "turn.failed") {
    const error = z.object({ code: z.string().optional(), message: z.string().min(1) }).passthrough().parse(value.error);
    const denied = /(?:sandbox|permission|denied)/i.test(`${error.code ?? ""} ${error.message}`);
    if (denied) return [
      { ...base, type: "approval.required", capability: error.code ?? "workspace", reason: error.message, resumeStrategy: "next_run" },
      { ...base, type: "run.failed", code: "permission_denied", message: error.message, retryable: true },
    ];
    return [{ ...base, type: "run.failed", code: "provider_error", message: error.message, retryable: false }];
  }
  return [];
}
