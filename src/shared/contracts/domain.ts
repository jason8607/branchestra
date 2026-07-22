import { z } from "zod";

const UuidSchema = z.string().uuid();
const TimestampSchema = z.string().datetime({ offset: true });
const GitOidSchema = z.string().regex(/^[0-9a-f]{40,64}$/);

export const ProjectSchema = z.object({
  id: UuidSchema,
  repositoryRoot: z.string().min(1),
  gitCommonDir: z.string().min(1),
  displayName: z.string().min(1).max(200),
  headOid: GitOidSchema,
  defaultBranch: z.string().min(1).nullable(),
  createdAt: TimestampSchema
}).strict();

export const RoomSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  title: z.string().trim().min(1).max(120),
  createdAt: TimestampSchema
}).strict();

export const UserMessageSchema = z.object({
  id: UuidSchema,
  roomId: UuidSchema,
  body: z.string().trim().min(1).max(20_000),
  createdAt: TimestampSchema
}).strict();

export const RoomEventSchema = z.object({
  id: UuidSchema,
  roomId: UuidSchema,
  roomSeq: z.number().int().positive(),
  type: z.literal("message.posted"),
  actor: z.enum(["user", "claude", "codex", "system"]),
  payload: UserMessageSchema,
  createdAt: TimestampSchema
}).strict();

export const AppSnapshotSchema = z.object({
  projects: z.array(ProjectSchema),
  rooms: z.array(RoomSchema),
  roomCursors: z.record(UuidSchema, z.number().int().nonnegative())
}).strict();

export const RoomEventCursorSchema = z.object({
  roomId: UuidSchema,
  roomSeq: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(500)
}).strict();

export const RoomEventPageSchema = z.object({
  roomId: UuidSchema,
  events: z.array(RoomEventSchema),
  nextRoomSeq: z.number().int().nonnegative(),
  hasMore: z.boolean()
}).strict();

export type Project = z.infer<typeof ProjectSchema>;
export type Room = z.infer<typeof RoomSchema>;
export type UserMessage = z.infer<typeof UserMessageSchema>;
export type RoomEvent = z.infer<typeof RoomEventSchema>;
export type AppSnapshot = z.infer<typeof AppSnapshotSchema>;
export type RoomEventCursor = z.infer<typeof RoomEventCursorSchema>;
export type RoomEventPage = z.infer<typeof RoomEventPageSchema>;

export interface Clock { now(): string; }
export interface IdGenerator { next(): string; }
