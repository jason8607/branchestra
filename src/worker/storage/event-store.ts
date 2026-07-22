import type {
  AppSnapshot,
  RoomEvent,
  RoomEventCursor,
  RoomEventPage,
  UserMessage
} from "../../shared/contracts/domain";
import {
  AppSnapshotSchema,
  RoomEventPageSchema,
  RoomEventSchema
} from "../../shared/contracts/domain";
import { NotFoundError } from "../domain/errors";
import type { Database } from "./database";
import type { DomainRepositories } from "./repositories";

export interface AppendRoomEventInput {
  id: string;
  roomId: string;
  type: "message.posted";
  actor: "user" | "claude" | "codex" | "system";
  payload: UserMessage;
  createdAt: string;
}

export interface EventStore {
  append(input: AppendRoomEventInput): RoomEvent;
  snapshot(): AppSnapshot;
  after(cursor: RoomEventCursor): RoomEventPage;
}

export function createEventStore(database: Database, repositories: DomainRepositories): EventStore {
  return {
    append(input) {
      return database.transaction(() => {
        if (!repositories.rooms.findById(input.roomId)) {
          throw new NotFoundError(`Room not found: ${input.roomId}`);
        }
        const row = database.prepare("SELECT COALESCE(MAX(room_seq), 0) + 1 AS next_seq FROM room_events WHERE room_id = ?").get(input.roomId) as { next_seq: number };
        const event = RoomEventSchema.parse({ ...input, roomSeq: row.next_seq });
        if (event.payload.roomId !== event.roomId) {
          throw new Error(`Event payload roomId does not match event roomId: ${event.id}`);
        }
        database.prepare("INSERT INTO room_events(id, room_id, room_seq, event_type, actor, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(event.id, event.roomId, event.roomSeq, event.type, event.actor, JSON.stringify(event.payload), event.createdAt);
        return event;
      });
    },
    snapshot() {
      return database.transaction(() => {
        const cursorRows = database.prepare("SELECT room_id, MAX(room_seq) AS room_seq FROM room_events GROUP BY room_id").all() as Array<{ room_id: string; room_seq: number }>;
        const rooms = repositories.rooms.list();
        const roomCursors: Record<string, number> = Object.fromEntries(rooms.map((room) => [room.id, 0]));
        for (const row of cursorRows) roomCursors[row.room_id] = row.room_seq;
        return AppSnapshotSchema.parse({
          projects: repositories.projects.list(),
          rooms,
          roomCursors
        });
      });
    },
    after(cursor) {
      const rows = database.prepare("SELECT id, room_id, room_seq, event_type, actor, payload_json, created_at FROM room_events WHERE room_id = ? AND room_seq > ? ORDER BY room_seq LIMIT ?").all(cursor.roomId, cursor.roomSeq, cursor.limit + 1) as Array<{ id: string; room_id: string; room_seq: number; event_type: string; actor: string; payload_json: string; created_at: string }>;
      const hasMore = rows.length > cursor.limit;
      const events = rows.slice(0, cursor.limit).map((row) => RoomEventSchema.parse({
        id: row.id,
        roomId: row.room_id,
        roomSeq: row.room_seq,
        type: row.event_type,
        actor: row.actor,
        payload: JSON.parse(String(row.payload_json)),
        createdAt: row.created_at
      }));
      const nextRoomSeq = events.at(-1)?.roomSeq ?? cursor.roomSeq;
      return RoomEventPageSchema.parse({ roomId: cursor.roomId, events, nextRoomSeq, hasMore });
    }
  };
}
