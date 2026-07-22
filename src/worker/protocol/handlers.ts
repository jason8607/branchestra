import { randomUUID } from "node:crypto";
import { SnapshotPageSchema, type AppSnapshot, type SnapshotPage } from "../../shared/contracts/domain";
import { MAX_IPC_BYTES, encodedEnvelopeBytes, type WorkerCommand } from "../../shared/contracts/protocol";
import type { ProjectService } from "../domain/project-service";
import type { RoomService } from "../domain/room-service";
import type { AnyCommandHandler, CommandHandler } from "./command-handler";

export interface CommandHandlerServices {
  projectService: ProjectService;
  roomService: RoomService;
  prepareQuit(deadlineMs: number): Promise<void>;
}

type CanonicalHandlers = {
  [TType in WorkerCommand["type"]]: CommandHandler<TType>;
};

export function createCommandHandlers(
  services: CommandHandlerServices
): readonly AnyCommandHandler[] {
  type SnapshotEntry =
    | { kind: "project"; value: AppSnapshot["projects"][number] }
    | { kind: "room"; value: AppSnapshot["rooms"][number] }
    | { kind: "cursor"; roomId: string; roomSeq: number };
  const snapshotSessions = new Map<string, {
    entries: readonly SnapshotEntry[];
    nextCursor: number;
  }>();
  const pageSnapshot = (snapshotId: string, entries: readonly SnapshotEntry[], cursor: number): SnapshotPage => {
    if (cursor < 0 || cursor > entries.length) throw new Error("Snapshot cursor is invalid");
    const page = { snapshotId, projects: [], rooms: [], roomCursors: {}, nextCursor: cursor, hasMore: false } as SnapshotPage;
    for (let index = cursor; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const candidate: SnapshotPage = {
        ...page,
        projects: [...page.projects],
        rooms: [...page.rooms],
        roomCursors: { ...page.roomCursors },
        nextCursor: index + 1,
        hasMore: index + 1 < entries.length
      };
      if (entry.kind === "project") candidate.projects.push(entry.value);
      else if (entry.kind === "room") candidate.rooms.push(entry.value);
      else candidate.roomCursors[entry.roomId] = entry.roomSeq;
      if (encodedEnvelopeBytes(candidate) > MAX_IPC_BYTES - 2_048) break;
      Object.assign(page, candidate);
    }
    if (page.nextCursor === cursor && cursor < entries.length) {
      throw new Error("A single snapshot entry exceeds the IPC envelope limit");
    }
    return SnapshotPageSchema.parse(page);
  };
  const snapshotData = (payload: { snapshotId: string; cursor: number } | Record<string, never>) => {
    if ("snapshotId" in payload) {
      const session = snapshotSessions.get(payload.snapshotId);
      if (!session) throw new Error("Snapshot session is unavailable");
      if (payload.cursor !== session.nextCursor) throw new Error("Snapshot cursor is stale or skipped");
      const page = pageSnapshot(payload.snapshotId, session.entries, payload.cursor);
      if (!page.hasMore) snapshotSessions.delete(payload.snapshotId);
      else session.nextCursor = page.nextCursor;
      return page;
    }
    const snapshot = services.roomService.getSnapshot();
    if (encodedEnvelopeBytes(snapshot) <= MAX_IPC_BYTES - 2_048) return snapshot;
    const entries: SnapshotEntry[] = [
      ...snapshot.projects.map((value) => ({ kind: "project" as const, value })),
      ...snapshot.rooms.map((value) => ({ kind: "room" as const, value })),
      ...Object.entries(snapshot.roomCursors).map(([roomId, roomSeq]) => ({ kind: "cursor" as const, roomId, roomSeq }))
    ];
    const snapshotId = randomUUID();
    while (snapshotSessions.size >= 4) snapshotSessions.delete(snapshotSessions.keys().next().value!);
    const page = pageSnapshot(snapshotId, entries, 0);
    if (page.hasMore) snapshotSessions.set(snapshotId, { entries, nextCursor: page.nextCursor });
    return page;
  };
  const handlers: CanonicalHandlers = {
    "state.getSnapshot": {
      type: "state.getSnapshot",
      handle: (command) => ({ data: snapshotData(command.payload), replayed: false })
    },
    "room.replay": {
      type: "room.replay",
      handle: (command) => ({
        data: services.roomService.replayRoom(command.payload),
        replayed: false
      })
    },
    "project.addExisting": {
      type: "project.addExisting",
      handle: async (command, context) => {
        const result = await services.projectService.addExistingProject(
          command.payload,
          context.durable(command)
        );
        return { data: result.value, replayed: result.replayed };
      }
    },
    "room.create": {
      type: "room.create",
      handle: (command, context) => {
        const result = services.roomService.createRoom(command.payload, context.durable(command));
        return { data: result.value, replayed: result.replayed };
      }
    },
    "message.post": {
      type: "message.post",
      handle: (command, context) => {
        const result = services.roomService.postUserMessage(command.payload, context.durable(command));
        return { data: result.value, replayed: result.replayed };
      }
    },
    "worker.prepareQuit": {
      type: "worker.prepareQuit",
      handle: async (command) => {
        await services.prepareQuit(command.payload.deadlineMs);
        return { data: { prepared: true as const }, replayed: false };
      }
    }
  };

  return [
    handlers["state.getSnapshot"],
    handlers["room.replay"],
    handlers["project.addExisting"],
    handlers["room.create"],
    handlers["message.post"],
    handlers["worker.prepareQuit"]
  ];
}
