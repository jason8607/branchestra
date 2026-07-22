import { z } from "zod";
import {
  AppSnapshotSchema,
  ProjectSchema,
  RoomEventCursorSchema,
  RoomEventPageSchema,
  RoomEventSchema,
  RoomSchema,
  SnapshotPageSchema
} from "./domain";

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
const messagePost = z.object({ roomId: UuidSchema, body: z.string().trim().min(1).max(20_000) }).strict();

export const RendererRequestEnvelopeSchema = z.discriminatedUnion("type", [
  z.object({ ...base, workerGeneration: z.union([GenerationSchema, z.literal(ZERO_WORKER_GENERATION)]), type: z.literal("state.getSnapshot"), payload: snapshotRequest }).strict(),
  z.object({ ...base, type: z.literal("room.replay"), payload: RoomEventCursorSchema }).strict(),
  z.object({ ...base, type: z.literal("project.pickExisting"), payload: empty }).strict(),
  z.object({ ...base, type: z.literal("room.create"), payload: roomCreate }).strict(),
  z.object({ ...base, type: z.literal("message.post"), payload: messagePost }).strict()
]);

export const WorkerRequestEnvelopeSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("state.getSnapshot"), payload: snapshotRequest }).strict(),
  z.object({ ...base, type: z.literal("room.replay"), payload: RoomEventCursorSchema }).strict(),
  z.object({ ...base, type: z.literal("project.addExisting"), payload: z.object({ selectedPath: z.string().min(1) }).strict() }).strict(),
  z.object({ ...base, type: z.literal("room.create"), payload: roomCreate }).strict(),
  z.object({ ...base, type: z.literal("message.post"), payload: messagePost }).strict(),
  z.object({ ...base, type: z.literal("worker.prepareQuit"), payload: z.object({ deadlineMs: z.number().int().positive() }).strict() }).strict()
]);

const responseData = z.union([AppSnapshotSchema, SnapshotPageSchema, RoomEventPageSchema, ProjectSchema, RoomSchema, RoomEventSchema, z.object({ cancelled: z.literal(true) }).strict(), z.object({ prepared: z.literal(true) }).strict()]);
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
