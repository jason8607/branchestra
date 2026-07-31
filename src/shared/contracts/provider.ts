import { z } from "zod";

export const ProviderIdSchema = z.enum(["claude", "codex"]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ProviderCapabilitiesSchema = z.object({
  interactiveApproval: z.boolean(),
  protocolInterrupt: z.boolean(),
  processAbort: z.boolean(),
  textDeltaStreaming: z.boolean(),
  itemEventStreaming: z.boolean(),
  sessionResume: z.boolean(),
  workspaceWriteSandbox: z.boolean(),
  toolNetworkControl: z.boolean(),
  contextTools: z.enum(["mcp", "injected"]),
}).strict();
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

const ProviderEventBaseSchema = z.object({
  runId: z.string().uuid(),
  provider: ProviderIdSchema,
  providerSeq: z.number().int().nonnegative(),
  occurredAt: z.string().datetime(),
});

export const ProviderEventSchema = z.discriminatedUnion("type", [
  ProviderEventBaseSchema.extend({ type: z.literal("session.started"), sessionId: z.string().min(1) }),
  ProviderEventBaseSchema.extend({ type: z.literal("assistant.delta"), messageId: z.string().min(1), text: z.string() }),
  ProviderEventBaseSchema.extend({ type: z.literal("assistant.completed"), messageId: z.string().min(1), text: z.string() }),
  ProviderEventBaseSchema.extend({
    type: z.literal("item.snapshot"), itemId: z.string().min(1), itemType: z.string().min(1),
    status: z.enum(["started", "updated", "completed"]), summary: z.string(),
  }),
  ProviderEventBaseSchema.extend({
    type: z.literal("tool.started"), toolCallId: z.string().min(1), toolName: z.string().min(1), summary: z.string(),
  }),
  ProviderEventBaseSchema.extend({
    type: z.literal("tool.completed"), toolCallId: z.string().min(1), isError: z.boolean(), summary: z.string(),
  }),
  ProviderEventBaseSchema.extend({
    type: z.literal("usage"), inputTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional(),
  }),
  ProviderEventBaseSchema.extend({
    type: z.literal("approval.required"), capability: z.string().min(1), reason: z.string().min(1),
    resumeStrategy: z.literal("next_run"),
  }),
  ProviderEventBaseSchema.extend({ type: z.literal("run.completed"), result: z.string() }),
  ProviderEventBaseSchema.extend({
    type: z.literal("run.failed"),
    code: z.enum(["aborted", "auth_unavailable", "incompatible", "permission_denied", "provider_error", "protocol_error"]),
    message: z.string().min(1), retryable: z.boolean(),
  }),
]);
export type ProviderEvent = z.infer<typeof ProviderEventSchema>;

export const ApprovedRunCapabilitiesSchema = z.object({
  workspaceRootRealpath: z.string().startsWith("/"),
  readableRootsRealpath: z.array(z.string().startsWith("/")),
  commandClasses: z.array(z.enum(["build", "test", "lint", "format"])),
  toolNetwork: z.boolean(),
  allowCollaborator: z.boolean(),
  maxRunMs: z.number().int().positive(),
}).strict();
export type ApprovedRunCapabilities = z.infer<typeof ApprovedRunCapabilitiesSchema>;

export const ProviderRunPayloadSchema = z.object({
  taskId: z.string().min(1),
  roomId: z.string().min(1),
  role: z.enum(["lead", "collaborator"]),
  instruction: z.string().min(1),
  worktreePath: z.string().startsWith("/"),
  contextVersion: z.number().int().positive(),
  contextHash: z.string().regex(/^[a-f0-9]{64}$/),
  approvedCapabilities: ApprovedRunCapabilitiesSchema,
  deniedWriteRoots: z.array(z.string().startsWith("/")),
  environment: z.record(z.string(), z.string()),
}).strict();
export type ProviderRunPayload = z.infer<typeof ProviderRunPayloadSchema>;

export interface ContextMessage {
  eventId: string;
  roomSeq: number;
  author: "user" | ProviderId;
  body: string;
}

export interface ContextBundlePayload {
  task: { instruction: string; approvedScope: string; lead: ProviderId };
  recentVerbatim: readonly ContextMessage[];
  roomMemory: { summaryVersion: number; summary: string; decisions: readonly string[] };
  relevantHistory: readonly ContextMessage[];
  peer: {
    messages: readonly ContextMessage[];
    checkpointOid: string | null;
    diffSummary: string | null;
    tests: readonly string[];
    toolSummaries: readonly string[];
  };
  injectedReadOnlySnapshot: string | null;
}

export interface ContextBundle {
  version: number;
  hash: string;
  roomId: string;
  taskId: string;
  role: "lead" | "collaborator";
  payload: ContextBundlePayload;
}

const ContextMessageSchema = z.object({
  eventId: z.string().min(1), roomSeq: z.number().int().nonnegative(),
  author: z.union([z.literal("user"), ProviderIdSchema]), body: z.string(),
}).strict();
const ContextBundlePayloadSchema = z.object({
  task: z.object({ instruction: z.string(), approvedScope: z.string(), lead: ProviderIdSchema }).strict(),
  recentVerbatim: z.array(ContextMessageSchema),
  roomMemory: z.object({ summaryVersion: z.number().int().nonnegative(), summary: z.string(), decisions: z.array(z.string()) }).strict(),
  relevantHistory: z.array(ContextMessageSchema),
  peer: z.object({
    messages: z.array(ContextMessageSchema), checkpointOid: z.string().nullable(), diffSummary: z.string().nullable(),
    tests: z.array(z.string()), toolSummaries: z.array(z.string()),
  }).strict(),
  injectedReadOnlySnapshot: z.string().nullable(),
}).strict();
export const ContextBundleSchema = z.object({
  version: z.number().int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/),
  roomId: z.string().min(1), taskId: z.string().min(1), role: z.enum(["lead", "collaborator"]),
  payload: ContextBundlePayloadSchema,
}).strict();

export interface ProviderHealth {
  provider: ProviderId;
  state: "missing" | "incompatible" | "unauthenticated" | "policy_disabled" | "ready";
  executableRealpath: string | null;
  cliVersion: string | null;
  sdkVersion: string;
  architecture: "arm64" | "x64";
  authLabel: "Subscription-only";
  capabilities: ProviderCapabilities | null;
  repairAction: string | null;
}

export const ProviderHealthSchema = z.object({
  provider: ProviderIdSchema,
  state: z.enum(["missing", "incompatible", "unauthenticated", "policy_disabled", "ready"]),
  executableRealpath: z.string().min(1).nullable(),
  cliVersion: z.string().min(1).nullable(),
  sdkVersion: z.string().min(1),
  architecture: z.enum(["arm64", "x64"]),
  authLabel: z.literal("Subscription-only"),
  capabilities: ProviderCapabilitiesSchema.nullable(),
  repairAction: z.string().min(1).nullable(),
}).strict();
