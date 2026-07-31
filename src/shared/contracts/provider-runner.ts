import { z } from "zod";
import { ProviderIdSchema, ProviderRunPayloadSchema } from "./provider";

const RunId = z.string().uuid();
const start = z.object({
  type: z.literal("run.start"), runId: RunId, provider: ProviderIdSchema,
  executableRealpath: z.string().startsWith("/"), codexConfigLockRealpath: z.string().startsWith("/").nullable(),
  request: ProviderRunPayloadSchema,
}).strict();
const resume = z.object({
  type: z.literal("run.resume"), runId: RunId, provider: ProviderIdSchema,
  executableRealpath: z.string().startsWith("/"), codexConfigLockRealpath: z.string().startsWith("/").nullable(),
  providerSessionId: z.string().min(1), request: ProviderRunPayloadSchema,
}).strict();
export const ProviderRunnerCommandSchema = z.discriminatedUnion("type", [
  start, resume,
  z.object({ type: z.literal("run.cancel"), runId: RunId, reason: z.enum(["user", "quit", "timeout"]), deadlineAt: z.string().datetime() }).strict(),
  z.object({ type: z.literal("tool.result"), runId: RunId, callId: z.string().uuid(), result: z.object({ content: z.string(), truncated: z.boolean() }).strict() }).strict(),
]).superRefine((value, context) => {
  if (value.type !== "run.start" && value.type !== "run.resume") return;
  const valid = value.provider === "codex" ? value.codexConfigLockRealpath !== null : value.codexConfigLockRealpath === null;
  if (!valid) context.addIssue({ code: "custom", message: "Provider config lock does not match Provider" });
});

export const ProviderRunnerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("runner.ready"), runId: RunId, pid: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("provider.raw"), runId: RunId, providerSeq: z.number().int().nonnegative(), receivedAt: z.string().datetime(), payload: z.unknown() }).strict(),
  z.object({ type: z.literal("tool.call"), runId: RunId, callId: z.string().uuid(), request: z.unknown() }).strict(),
  z.object({ type: z.literal("run.completed"), runId: RunId }).strict(),
  z.object({ type: z.literal("run.failed"), runId: RunId, code: z.string().min(1), message: z.string().min(1) }).strict(),
  z.object({ type: z.literal("run.cancelled"), runId: RunId }).strict(),
]);
export type ProviderRunnerCommand = z.infer<typeof ProviderRunnerCommandSchema>;
export type ProviderRunnerMessage = z.infer<typeof ProviderRunnerMessageSchema>;
