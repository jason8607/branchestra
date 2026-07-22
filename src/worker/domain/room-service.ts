import type {
  AppSnapshot,
  Clock,
  IdGenerator,
  Room,
  RoomEvent,
  RoomEventCursor,
  RoomEventPage
} from "../../shared/contracts/domain";
import { RoomEventSchema, RoomSchema } from "../../shared/contracts/domain";
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
      return dependencies.idempotencyStore.execute(metadata, RoomSchema, () => {
        if (!dependencies.repositories.projects.findById(input.projectId)) {
          throw new Error(`Project not found: ${input.projectId}`);
        }
        return dependencies.repositories.rooms.insert(RoomSchema.parse({
          id: dependencies.ids.next(),
          projectId: input.projectId,
          title: input.title,
          createdAt: dependencies.clock.now()
        }));
      });
    },
    postUserMessage(input, metadata) {
      return dependencies.idempotencyStore.execute(metadata, RoomEventSchema, () => {
        const createdAt = dependencies.clock.now();
        const messageId = dependencies.ids.next();
        return dependencies.eventStore.append({
          id: dependencies.ids.next(),
          roomId: input.roomId,
          type: "message.posted",
          actor: "user",
          payload: {
            id: messageId,
            roomId: input.roomId,
            body: input.body,
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
