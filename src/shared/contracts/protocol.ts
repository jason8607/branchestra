import { z } from "zod";
import {
  AppSnapshotSchema,
  ProjectSchema,
  RoomEventCursorSchema,
  RoomEventPageSchema,
  RoomEventSchema,
  RoomSchema,
  SnapshotPageSchema,
  TaskRecordSchema
} from "./domain";
import type { FinalApprovalTuple } from "./domain";

export const PROTOCOL_VERSION = 1 as const;
export const MAX_IPC_BYTES = 65_536;
export const ZERO_WORKER_GENERATION = "00000000-0000-0000-0000-000000000000";

const UuidSchema = z.string().uuid();
const GenerationSchema = UuidSchema.refine((value) => value !== ZERO_WORKER_GENERATION, "active worker generation required");
const base = {
  v: z.literal(PROTOCOL_VERSION),
  requestId: UuidSchema,
  idempotencyKey: z.string().min(1).max(128),
  workerGeneration: GenerationSchema
};
const empty = z.object({}).strict();
const snapshotPageRequest = z.object({
  snapshotId: UuidSchema,
  cursor: z.number().int().nonnegative()
}).strict();
const snapshotRequest = z.union([empty, snapshotPageRequest]);
const roomCreate = z.object({ projectId: UuidSchema, title: z.string().trim().min(1).max(120) }).strict();
const messagePost = z.object({
  roomId: UuidSchema,
  body: z.string().trim().min(1).max(20_000),
  leadProvider: z.enum(["claude", "codex"]).optional(),
  commandClasses: z.array(z.enum(["build", "test", "lint", "format"])).optional(),
  allowCollaborator: z.boolean().optional(),
  toolNetwork: z.boolean().optional(),
  maxRunMs: z.number().int().min(1).max(3_600_000).optional(),
  collaborationRoundBudget: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional()
}).strict();
const TaskIdSchema = z.string().min(1);
const ApprovalRequestIdSchema = z.string().min(1);
const ScopeHashSchema = z.string().regex(/^sha256:.+/);
const TaskTargetRefSchema = z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]+$/);
const TaskOidSchema = z.string().regex(/^[0-9a-f]{40,64}$/);
const finalApprovalTuple = z.object({
  targetRef: TaskTargetRefSchema,
  baseOid: TaskOidSchema,
  candidateOid: TaskOidSchema,
  diffHash: ScopeHashSchema,
  testSetHash: ScopeHashSchema
}).strict();
const taskGet = z.object({ taskId: TaskIdSchema }).strict();
const taskApproveScope = z.object({
  taskId: TaskIdSchema, approvalRequestId: ApprovalRequestIdSchema,
  decision: z.enum(["approved", "rejected"]), displayedScopeHash: ScopeHashSchema
}).strict();
const taskCancel = z.object({ taskId: TaskIdSchema, reason: z.enum(["user", "quit", "timeout"]) }).strict();
const taskRequestRevision = z.object({ taskId: TaskIdSchema, instruction: z.string().min(1) }).strict();
const taskGrantAdditionalRound = z.object({
  taskId: TaskIdSchema, approvalRequestId: ApprovalRequestIdSchema,
  additionalRounds: z.union([z.literal(1), z.literal(2)]), displayedScopeHash: ScopeHashSchema
}).strict();
const taskApproveFinalMerge = z.object({ taskId: TaskIdSchema, approvalRequestId: ApprovalRequestIdSchema })
  .extend(finalApprovalTuple.shape).strict();
const taskRecoveryResolve = z.object({
  taskId: TaskIdSchema, previewHash: ScopeHashSchema,
  decision: z.enum(["resume_recorded_phase", "keep_observed_state", "cancel_and_retain"]),
  selectedOperationIds: z.array(z.string().min(1))
}).strict();

export const RendererRequestEnvelopeSchema = z.discriminatedUnion("type", [
  z.object({ ...base, workerGeneration: z.union([GenerationSchema, z.literal(ZERO_WORKER_GENERATION)]), type: z.literal("state.getSnapshot"), payload: snapshotRequest }).strict(),
  z.object({ ...base, type: z.literal("room.replay"), payload: RoomEventCursorSchema }).strict(),
  z.object({ ...base, type: z.literal("project.pickExisting"), payload: empty }).strict(),
  z.object({ ...base, type: z.literal("room.create"), payload: roomCreate }).strict(),
  z.object({ ...base, type: z.literal("message.post"), payload: messagePost }).strict(),
  z.object({ ...base, type: z.literal("task.get"), payload: taskGet }).strict(),
  z.object({ ...base, type: z.literal("task.approveScope"), payload: taskApproveScope }).strict(),
  z.object({ ...base, type: z.literal("task.cancel"), payload: taskCancel }).strict(),
  z.object({ ...base, type: z.literal("task.requestRevision"), payload: taskRequestRevision }).strict(),
  z.object({ ...base, type: z.literal("task.grantAdditionalRound"), payload: taskGrantAdditionalRound }).strict(),
  z.object({ ...base, type: z.literal("task.approveFinalMerge"), payload: taskApproveFinalMerge }).strict(),
  z.object({ ...base, type: z.literal("task.recovery.preview"), payload: taskGet }).strict(),
  z.object({ ...base, type: z.literal("task.recovery.resolve"), payload: taskRecoveryResolve }).strict()
]);

export const WorkerRequestEnvelopeSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("state.getSnapshot"), payload: snapshotRequest }).strict(),
  z.object({ ...base, type: z.literal("room.replay"), payload: RoomEventCursorSchema }).strict(),
  z.object({ ...base, type: z.literal("project.addExisting"), payload: z.object({ selectedPath: z.string().min(1) }).strict() }).strict(),
  z.object({ ...base, type: z.literal("room.create"), payload: roomCreate }).strict(),
  z.object({ ...base, type: z.literal("message.post"), payload: messagePost }).strict(),
  z.object({ ...base, type: z.literal("task.approveScope"), payload: taskApproveScope }).strict(),
  z.object({ ...base, type: z.literal("task.grantAdditionalRound"), payload: taskGrantAdditionalRound }).strict(),
  z.object({ ...base, type: z.literal("worker.prepareQuit"), payload: z.object({ deadlineMs: z.number().int().positive() }).strict() }).strict()
]);

const responseData = z.union([AppSnapshotSchema, SnapshotPageSchema, RoomEventPageSchema, ProjectSchema, RoomSchema, RoomEventSchema, TaskRecordSchema, z.object({ cancelled: z.literal(true) }).strict(), z.object({ prepared: z.literal(true) }).strict()]);
export const WorkerResponseEnvelopeSchema = z.object({
  ...base,
  type: z.literal("response"),
  payload: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), requestType: z.string().min(1), data: responseData, replayed: z.boolean() }).strict(),
    z.object({ ok: z.literal(false), requestType: z.string().min(1), code: z.enum(["INVALID_REQUEST", "STALE_WORKER_GENERATION", "IDEMPOTENCY_CONFLICT", "LEASE_HELD", "NOT_FOUND", "GIT_INVALID", "INTERNAL"]), message: z.string().min(1) }).strict()
  ])
}).strict();

export const WorkerEventEnvelopeSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("worker.ready"), payload: z.object({ protocolVersion: z.literal(PROTOCOL_VERSION) }).strict() }).strict(),
  z.object({ ...base, type: z.literal("worker.rejected"), payload: z.object({ code: z.literal("LEASE_HELD") }).strict() }).strict(),
  z.object({ ...base, type: z.literal("worker.disconnected"), payload: z.object({ reason: z.string().min(1) }).strict() }).strict(),
  z.object({ ...base, type: z.literal("room.event"), payload: RoomEventSchema }).strict(),
  z.object({ ...base, type: z.literal("state.invalidated"), payload: z.object({ roomId: UuidSchema.nullable() }).strict() }).strict()
]);

export type RendererRequestEnvelope = z.infer<typeof RendererRequestEnvelopeSchema>;
export type WorkerRequestEnvelope = z.infer<typeof WorkerRequestEnvelopeSchema>;
export type WorkerResponseEnvelope = z.infer<typeof WorkerResponseEnvelopeSchema>;
export type WorkerEventEnvelope = z.infer<typeof WorkerEventEnvelopeSchema>;
type CommandFromEnvelope<E> = E extends { type: infer T; payload: infer P }
  ? { type: T; payload: P }
  : never;
export type RendererCommand = CommandFromEnvelope<RendererRequestEnvelope> extends infer C
  ? C extends { type: string; payload: unknown }
    ? C & { idempotencyKey: string }
    : never
  : never;
export type WorkerCommand = CommandFromEnvelope<WorkerRequestEnvelope>;
export type TaskWorkerCommand =
  | { type: "task.get"; payload: { taskId: string } }
  | { type: "task.approveScope"; payload: { taskId: string; approvalRequestId: string; decision: "approved" | "rejected"; displayedScopeHash: string } }
  | { type: "task.cancel"; payload: { taskId: string; reason: "user" | "quit" | "timeout" } }
  | { type: "task.requestRevision"; payload: { taskId: string; instruction: string } }
  | { type: "task.grantAdditionalRound"; payload: { taskId: string; approvalRequestId: string; additionalRounds: 1 | 2; displayedScopeHash: string } }
  | ({ type: "task.approveFinalMerge"; payload: { taskId: string; approvalRequestId: string } & FinalApprovalTuple })
  | { type: "task.recovery.preview"; payload: { taskId: string } }
  | { type: "task.recovery.resolve"; payload: { taskId: string; previewHash: string; decision: "resume_recorded_phase" | "keep_observed_state" | "cancel_and_retain"; selectedOperationIds: string[] } };
export type WorkerResponsePayload = WorkerResponseEnvelope["payload"];

export function assertEnvelopeSize(value: unknown): void {
  const size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (size > MAX_IPC_BYTES) throw new Error(`IPC envelope exceeds ${MAX_IPC_BYTES} bytes`);
}

export function encodedEnvelopeBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function parseEnvelope<T>(schema: z.ZodType<T>, value: unknown): T {
  assertEnvelopeSize(value);
  return schema.parse(value);
}

export function postEnvelope(post: (value: unknown) => void, value: unknown): void {
  assertEnvelopeSize(value);
  post(value);
}
