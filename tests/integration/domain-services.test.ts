import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/worker/storage/database";
import { createEventStore } from "../../src/worker/storage/event-store";
import { createIdempotencyStore } from "../../src/worker/storage/idempotency-store";
import { runMigrations } from "../../src/worker/storage/migrations";
import { createRepositories } from "../../src/worker/storage/repositories";
import { createProjectService } from "../../src/worker/domain/project-service";
import { createRoomService } from "../../src/worker/domain/room-service";

describe("foundation domain services", () => {
  it("persists a validated project, multiple rooms, and room-local messages", async () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const repositories = createRepositories(database);
      const events = createEventStore(database, repositories);
      const dedupe = createIdempotencyStore(database, () => "2026-07-21T12:00:00.000Z");
      const ids = [
        "10000000-0000-4000-8000-000000000001",
        "20000000-0000-4000-8000-000000000001",
        "20000000-0000-4000-8000-000000000002",
        "30000000-0000-4000-8000-000000000001",
        "40000000-0000-4000-8000-000000000001"
      ];
      const common = {
        repositories,
        eventStore: events,
        idempotencyStore: dedupe,
        clock: { now: () => "2026-07-21T12:00:00.000Z" },
        ids: { next: () => ids.shift() ?? (() => { throw new Error("ID exhausted"); })() }
      };
      const projects = createProjectService({
        ...common,
        inspectRepository: async () => ({
          repositoryRoot: "/repo",
          gitCommonDir: "/repo/.git",
          headOid: "a".repeat(40),
          defaultBranch: "main"
        })
      });
      const rooms = createRoomService(common);
      const metadata = (key: string, type: string) => ({
        idempotencyKey: key,
        requestType: type,
        requestHash: `${key}-hash`,
        workerGeneration: "50000000-0000-4000-8000-000000000001"
      });
      const project = (await projects.addExistingProject(
        { selectedPath: "/chosen" },
        metadata("project-1", "project.addExisting")
      )).value;
      const roomA = rooms.createRoom(
        { projectId: project.id, title: "Architecture" },
        metadata("room-a", "room.create")
      ).value;
      const roomB = rooms.createRoom(
        { projectId: project.id, title: "UX" },
        metadata("room-b", "room.create")
      ).value;
      const first = rooms.postUserMessage(
        { roomId: roomA.id, body: "Persist this" },
        metadata("message-a", "message.post")
      );
      const replayed = rooms.postUserMessage(
        { roomId: roomA.id, body: "Persist this" },
        metadata("message-a", "message.post")
      );

      expect(replayed).toMatchObject({ replayed: true, value: { id: first.value.id, roomSeq: 1 } });
      expect(rooms.replayRoom({ roomId: roomA.id, roomSeq: 0, limit: 100 }).events.map((event) => event.payload.body)).toEqual(["Persist this"]);
      expect(rooms.replayRoom({ roomId: roomB.id, roomSeq: 0, limit: 100 }).events).toEqual([]);
      expect(rooms.getSnapshot()).toMatchObject({
        projects: [{ id: project.id }],
        rooms: [{ id: roomA.id }, { id: roomB.id }]
      });
    } finally {
      database.close();
    }
  });
});
