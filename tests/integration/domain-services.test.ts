import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/worker/storage/database";
import { createEventStore } from "../../src/worker/storage/event-store";
import {
  createIdempotencyStore,
  IdempotencyConflictError
} from "../../src/worker/storage/idempotency-store";
import { runMigrations } from "../../src/worker/storage/migrations";
import { createRepositories } from "../../src/worker/storage/repositories";
import { createProjectService } from "../../src/worker/domain/project-service";
import { NotFoundError } from "../../src/worker/domain/errors";
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
      expect(rooms.replayRoom({ roomId: roomA.id, roomSeq: 0, limit: 100 }).events
        .filter((event) => event.type === "message.posted").map((event) => event.payload.body)).toEqual(["Persist this"]);
      expect(rooms.replayRoom({ roomId: roomB.id, roomSeq: 0, limit: 100 }).events).toEqual([]);
      expect(rooms.getSnapshot()).toMatchObject({
        projects: [{ id: project.id }],
        rooms: [{ id: roomA.id }, { id: roomB.id }]
      });
    } finally {
      database.close();
    }
  });

  it("replays a completed project command before repository inspection", async () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const repositories = createRepositories(database);
      const dedupe = createIdempotencyStore(database, () => "2026-07-21T12:00:00.000Z");
      let idCalls = 0;
      let inspectorCalls = 0;
      const ids = { next: () => {
        idCalls += 1;
        return "10000000-0000-4000-8000-000000000001";
      } };
      const metadata = {
        idempotencyKey: "project-retry",
        requestType: "project.addExisting",
        requestHash: "project-retry-hash",
        workerGeneration: "50000000-0000-4000-8000-000000000001"
      };
      const common = {
        repositories,
        idempotencyStore: dedupe,
        clock: { now: () => "2026-07-21T12:00:00.000Z" },
        ids
      };
      const firstService = createProjectService({
        ...common,
        inspectRepository: async () => {
          inspectorCalls += 1;
          return { repositoryRoot: "/repo", gitCommonDir: "/repo/.git", headOid: "a".repeat(40), defaultBranch: "main" };
        }
      });
      const first = await firstService.addExistingProject({ selectedPath: "/chosen" }, metadata);
      const retryService = createProjectService({
        ...common,
        inspectRepository: async () => {
          inspectorCalls += 1;
          throw new Error("inspector must not run for replay");
        }
      });

      await expect(retryService.addExistingProject({ selectedPath: "/chosen" }, metadata)).resolves.toEqual({
        value: first.value,
        replayed: true
      });
      expect({ inspectorCalls, idCalls }).toEqual({ inspectorCalls: 1, idCalls: 1 });
    } finally {
      database.close();
    }
  });

  it("persists the filesystem root with a non-empty display name and one ID", async () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const repositories = createRepositories(database);
      let idCalls = 0;
      const projects = createProjectService({
        repositories,
        idempotencyStore: createIdempotencyStore(database, () => "2026-07-21T12:00:00.000Z"),
        inspectRepository: async () => ({
          repositoryRoot: "/",
          gitCommonDir: "/.git",
          headOid: "a".repeat(40),
          defaultBranch: "main"
        }),
        clock: { now: () => "2026-07-21T12:00:00.000Z" },
        ids: { next: () => {
          idCalls += 1;
          return "10000000-0000-4000-8000-000000000001";
        } }
      });

      const result = await projects.addExistingProject({ selectedPath: "/" }, {
        idempotencyKey: "root-project",
        requestType: "project.addExisting",
        requestHash: "root-project-hash",
        workerGeneration: "50000000-0000-4000-8000-000000000001"
      });

      expect(result).toMatchObject({ value: { repositoryRoot: "/", displayName: "/" }, replayed: false });
      expect(repositories.projects.findById(result.value.id)).toEqual(result.value);
      expect(idCalls).toBe(1);
    } finally {
      database.close();
    }
  });

  it("validates a derived project display name before allocating an ID", async () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const repositories = createRepositories(database);
      let idCalls = 0;
      const projects = createProjectService({
        repositories,
        idempotencyStore: createIdempotencyStore(database, () => "2026-07-21T12:00:00.000Z"),
        inspectRepository: async () => ({
          repositoryRoot: `/${"a".repeat(201)}`,
          gitCommonDir: "/.git",
          headOid: "a".repeat(40),
          defaultBranch: "main"
        }),
        clock: { now: () => "2026-07-21T12:00:00.000Z" },
        ids: { next: () => {
          idCalls += 1;
          return "10000000-0000-4000-8000-000000000001";
        } }
      });

      await expect(projects.addExistingProject({ selectedPath: "/chosen" }, {
        idempotencyKey: "long-name-project",
        requestType: "project.addExisting",
        requestHash: "long-name-project-hash",
        workerGeneration: "50000000-0000-4000-8000-000000000001"
      })).rejects.toThrow();
      expect(idCalls).toBe(0);
      expect(database.prepare("SELECT count(*) AS count FROM idempotency_records").get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("rejects an unsupported inspected branch before storing a project or allocating an ID", async () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const repositories = createRepositories(database);
      let idCalls = 0;
      const projects = createProjectService({
        repositories,
        idempotencyStore: createIdempotencyStore(database, () => "2026-07-21T12:00:00.000Z"),
        inspectRepository: async () => ({
          repositoryRoot: "/repo",
          gitCommonDir: "/repo/.git",
          headOid: "a".repeat(40),
          defaultBranch: "日本語"
        }),
        clock: { now: () => "2026-07-21T12:00:00.000Z" },
        ids: { next: () => {
          idCalls += 1;
          return "10000000-0000-4000-8000-000000000001";
        } }
      });

      await expect(projects.addExistingProject({ selectedPath: "/repo" }, {
        idempotencyKey: "unsupported-project-ref",
        requestType: "project.addExisting",
        requestHash: "unsupported-project-ref-hash",
        workerGeneration: "50000000-0000-4000-8000-000000000001"
      })).rejects.toThrow("GIT_REF_UNSUPPORTED");
      expect(repositories.projects.list()).toEqual([]);
      expect(idCalls).toBe(0);
      expect(database.prepare("SELECT count(*) AS count FROM idempotency_records").get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("replays completed room and message commands before validation or dependency checks", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const repositories = createRepositories(database);
      const project = repositories.projects.insert({
        id: "10000000-0000-4000-8000-000000000001",
        repositoryRoot: "/repo",
        gitCommonDir: "/repo/.git",
        displayName: "repo",
        headOid: "a".repeat(40),
        defaultBranch: "main",
        createdAt: "2026-07-21T12:00:00.000Z"
      });
      const ids = [
        "20000000-0000-4000-8000-000000000001",
        "40000000-0000-4000-8000-000000000001",
        "30000000-0000-4000-8000-000000000001"
      ];
      let idCalls = 0;
      const rooms = createRoomService({
        repositories,
        eventStore: createEventStore(database, repositories),
        idempotencyStore: createIdempotencyStore(database, () => "2026-07-21T12:00:00.000Z"),
        clock: { now: () => "2026-07-21T12:00:00.000Z" },
        ids: { next: () => {
          idCalls += 1;
          return ids.shift() ?? (() => { throw new Error("ID exhausted"); })();
        } }
      });
      const roomMetadata = {
        idempotencyKey: "room-replay",
        requestType: "room.create",
        requestHash: "room-replay-hash",
        workerGeneration: "50000000-0000-4000-8000-000000000001"
      };
      const firstRoom = rooms.createRoom({ projectId: project.id, title: "Persisted" }, roomMetadata);
      const messageMetadata = {
        idempotencyKey: "message-replay",
        requestType: "message.post",
        requestHash: "message-replay-hash",
        workerGeneration: "50000000-0000-4000-8000-000000000001"
      };
      const firstMessage = rooms.postUserMessage({ roomId: firstRoom.value.id, body: "Persisted" }, messageMetadata);

      database.prepare("DELETE FROM projects WHERE id = ?").run(project.id);

      expect(rooms.createRoom({ projectId: project.id, title: " " }, roomMetadata)).toEqual({
        value: firstRoom.value,
        replayed: true
      });
      expect(rooms.postUserMessage({ roomId: firstRoom.value.id, body: " " }, messageMetadata)).toEqual({
        value: firstMessage.value,
        replayed: true
      });
      expect(() => rooms.createRoom(
        { projectId: project.id, title: " " },
        { ...roomMetadata, requestHash: "changed-room-hash" }
      )).toThrow(IdempotencyConflictError);
      expect(() => rooms.postUserMessage(
        { roomId: firstRoom.value.id, body: " " },
        { ...messageMetadata, requestHash: "changed-message-hash" }
      )).toThrow(IdempotencyConflictError);
      expect(idCalls).toBe(3);
    } finally {
      database.close();
    }
  });

  it("rejects invalid or missing room dependencies without durable side effects", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const repositories = createRepositories(database);
      const project = repositories.projects.insert({
        id: "10000000-0000-4000-8000-000000000001",
        repositoryRoot: "/repo",
        gitCommonDir: "/repo/.git",
        displayName: "repo",
        headOid: "a".repeat(40),
        defaultBranch: "main",
        createdAt: "2026-07-21T12:00:00.000Z"
      });
      const ids = { calls: 0, next() { this.calls += 1; return "20000000-0000-4000-8000-000000000001"; } };
      const rooms = createRoomService({
        repositories,
        eventStore: createEventStore(database, repositories),
        idempotencyStore: createIdempotencyStore(database, () => "2026-07-21T12:00:00.000Z"),
        clock: { now: () => "2026-07-21T12:00:00.000Z" },
        ids
      });
      const metadata = (key: string, type: string) => ({
        idempotencyKey: key,
        requestType: type,
        requestHash: `${key}-hash`,
        workerGeneration: "50000000-0000-4000-8000-000000000001"
      });

      expect(() => rooms.createRoom(
        { projectId: "10000000-0000-4000-8000-000000000002", title: "Valid" },
        metadata("missing-project", "room.create")
      )).toThrow(/Project not found/);
      expect(() => rooms.createRoom(
        { projectId: "10000000-0000-4000-8000-000000000002", title: "Valid" },
        metadata("missing-project-class", "room.create")
      )).toThrow(NotFoundError);
      expect(() => rooms.createRoom(
        { projectId: project.id, title: " " },
        metadata("invalid-title", "room.create")
      )).toThrow();
      expect(() => rooms.postUserMessage(
        { roomId: "20000000-0000-4000-8000-000000000002", body: "Valid" },
        metadata("missing-room", "message.post")
      )).toThrow(/Room not found/);
      expect(() => rooms.postUserMessage(
        { roomId: "20000000-0000-4000-8000-000000000002", body: "Valid" },
        metadata("missing-room-class", "message.post")
      )).toThrow(NotFoundError);
      expect(() => rooms.postUserMessage(
        { roomId: "20000000-0000-4000-8000-000000000002", body: " " },
        metadata("invalid-body", "message.post")
      )).toThrow();

      expect(ids.calls).toBe(0);
      expect(database.prepare("SELECT count(*) AS count FROM rooms").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT count(*) AS count FROM room_events").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT count(*) AS count FROM idempotency_records").get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
