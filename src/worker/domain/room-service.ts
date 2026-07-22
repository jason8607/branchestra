import type {
  AppSnapshot,
  Clock,
  IdGenerator,
  Room,
  RoomEvent,
  RoomEventCursor,
  RoomEventPage
} from "../../shared/contracts/domain";
import { RoomEventSchema, RoomSchema, UserMessageSchema } from "../../shared/contracts/domain";
import { NotFoundError } from "./errors";
import type { EventStore } from "../storage/event-store";
import type {
  DurableCommand,
  DurableResult,
  IdempotencyStore
} from "../storage/idempotency-store";
import type { DomainRepositories } from "../storage/repositories";

export interface RoomServiceDependencies {
  repositories: DomainRepositories;
  eventStore: EventStore;
  idempotencyStore: IdempotencyStore;
  clock: Clock;
  ids: IdGenerator;
}

export interface RoomService {
  createRoom(input: { projectId: string; title: string }, metadata: DurableCommand): DurableResult<Room>;
  postUserMessage(input: { roomId: string; body: string }, metadata: DurableCommand): DurableResult<RoomEvent>;
  getSnapshot(): AppSnapshot;
  replayRoom(cursor: RoomEventCursor): RoomEventPage;
}

export function createRoomService(dependencies: RoomServiceDependencies): RoomService {
  return {
    createRoom(input, metadata) {
      const replayed = dependencies.idempotencyStore.replay(metadata, RoomSchema);
      if (replayed) return replayed;
      const validatedInput = RoomSchema.pick({ projectId: true, title: true }).parse(input);
      return dependencies.idempotencyStore.execute(metadata, RoomSchema, () => {
        if (!dependencies.repositories.projects.findById(validatedInput.projectId)) {
          throw new NotFoundError(`Project not found: ${validatedInput.projectId}`);
        }
        return dependencies.repositories.rooms.insert(RoomSchema.parse({
          id: dependencies.ids.next(),
          projectId: validatedInput.projectId,
          title: validatedInput.title,
          createdAt: dependencies.clock.now()
        }));
      });
    },
    postUserMessage(input, metadata) {
      const replayed = dependencies.idempotencyStore.replay(metadata, RoomEventSchema);
      if (replayed) return replayed;
      const validatedInput = UserMessageSchema.pick({ roomId: true, body: true }).parse(input);
      return dependencies.idempotencyStore.execute(metadata, RoomEventSchema, () => {
        if (!dependencies.repositories.rooms.findById(validatedInput.roomId)) {
          throw new NotFoundError(`Room not found: ${validatedInput.roomId}`);
        }
        const createdAt = dependencies.clock.now();
        const messageId = dependencies.ids.next();
        return dependencies.eventStore.append({
          id: dependencies.ids.next(),
          roomId: validatedInput.roomId,
          type: "message.posted",
          actor: "user",
          payload: {
            id: messageId,
            roomId: validatedInput.roomId,
            body: validatedInput.body,
            createdAt
          },
          createdAt
        });
      });
    },
    getSnapshot: () => dependencies.eventStore.snapshot(),
    replayRoom: (cursor) => dependencies.eventStore.after(cursor)
  };
}
