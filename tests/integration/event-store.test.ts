import { describe, expect, it } from "vitest";
import { ProjectSchema } from "../../src/shared/contracts/domain";
import { NotFoundError } from "../../src/worker/domain/errors";
import { openDatabase } from "../../src/worker/storage/database";
import { createEventStore } from "../../src/worker/storage/event-store";
import {
  createIdempotencyStore,
  IdempotencyConflictError
} from "../../src/worker/storage/idempotency-store";
import { runMigrations } from "../../src/worker/storage/migrations";
import {
  createRepositories,
  type DomainRepositories
} from "../../src/worker/storage/repositories";
import type { Database } from "../../src/worker/storage/database";
import { MAX_IPC_BYTES, assertEnvelopeSize } from "../../src/shared/contracts/protocol";

describe("event storage", () => {
  it("throws a dedicated error when appending to a missing room", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const events = createEventStore(database, createRepositories(database));
      const input = {
        id: "30000000-0000-4000-8000-000000000001",
        roomId: "20000000-0000-4000-8000-000000000001",
        type: "message.posted" as const,
        actor: "user" as const,
        payload: {
          id: "40000000-0000-4000-8000-000000000001",
          roomId: "20000000-0000-4000-8000-000000000001",
          body: "missing room",
          createdAt: "2026-07-21T10:03:00.000Z"
        },
        createdAt: "2026-07-21T10:03:00.000Z"
      };

      expect(() => events.append(input)).toThrow("Room not found: 20000000-0000-4000-8000-000000000001");
      expect(() => events.append(input)).toThrow(NotFoundError);
    } finally {
      database.close();
    }
  });

  it("allocates room_seq per room and replays after a cursor", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const repositories = createRepositories(database);
      const project = repositories.projects.insert({ id: "10000000-0000-4000-8000-000000000001", repositoryRoot: "/repo", gitCommonDir: "/repo/.git", displayName: "repo", headOid: "a".repeat(40), defaultBranch: "main", createdAt: "2026-07-21T10:00:00.000Z" });
      const roomA = repositories.rooms.insert({ id: "20000000-0000-4000-8000-000000000001", projectId: project.id, title: "A", createdAt: "2026-07-21T10:01:00.000Z" });
      const roomB = repositories.rooms.insert({ id: "20000000-0000-4000-8000-000000000002", projectId: project.id, title: "B", createdAt: "2026-07-21T10:02:00.000Z" });
      const events = createEventStore(database, repositories);
      const first = events.append({ id: "30000000-0000-4000-8000-000000000001", roomId: roomA.id, type: "message.posted", actor: "user", payload: { id: "40000000-0000-4000-8000-000000000001", roomId: roomA.id, body: "one", createdAt: "2026-07-21T10:03:00.000Z" }, createdAt: "2026-07-21T10:03:00.000Z" });
      const second = events.append({ id: "30000000-0000-4000-8000-000000000002", roomId: roomA.id, type: "message.posted", actor: "user", payload: { id: "40000000-0000-4000-8000-000000000002", roomId: roomA.id, body: "two", createdAt: "2026-07-21T10:04:00.000Z" }, createdAt: "2026-07-21T10:04:00.000Z" });
      const other = events.append({ id: "30000000-0000-4000-8000-000000000003", roomId: roomB.id, type: "message.posted", actor: "user", payload: { id: "40000000-0000-4000-8000-000000000003", roomId: roomB.id, body: "other", createdAt: "2026-07-21T10:05:00.000Z" }, createdAt: "2026-07-21T10:05:00.000Z" });
      expect([first.roomSeq, second.roomSeq, other.roomSeq]).toEqual([1, 2, 1]);
      expect(events.snapshot().roomCursors).toEqual({ [roomA.id]: 2, [roomB.id]: 1 });
      expect(events.after({ roomId: roomA.id, roomSeq: 1, limit: 50 })).toMatchObject({ events: [{ roomSeq: 2 }], nextRoomSeq: 2, hasMore: false });
    } finally {
      database.close();
    }
  });

  it("byte-paginates four maximum-size messages into globally bounded response envelopes", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const repositories = createRepositories(database);
      const project = repositories.projects.insert({ id: "10000000-0000-4000-8000-000000000001", repositoryRoot: "/repo", gitCommonDir: "/repo/.git", displayName: "repo", headOid: "a".repeat(40), defaultBranch: "main", createdAt: "2026-07-21T10:00:00.000Z" });
      const room = repositories.rooms.insert({ id: "20000000-0000-4000-8000-000000000001", projectId: project.id, title: "A", createdAt: "2026-07-21T10:01:00.000Z" });
      const events = createEventStore(database, repositories);
      for (let index = 1; index <= 4; index += 1) {
        const suffix = String(index).padStart(12, "0");
        events.append({ id: `30000000-0000-4000-8000-${suffix}`, roomId: room.id, type: "message.posted", actor: "user", payload: { id: `40000000-0000-4000-8000-${suffix}`, roomId: room.id, body: "x".repeat(20_000), createdAt: "2026-07-21T10:03:00.000Z" }, createdAt: "2026-07-21T10:03:00.000Z" });
      }
      let cursor = 0;
      const collected: number[] = [];
      let hasMore = true;
      while (hasMore) {
        const page = events.after({ roomId: room.id, roomSeq: cursor, limit: 500 });
        const envelope = { v: 1, requestId: "10000000-0000-4000-8000-000000000001", idempotencyKey: "replay", workerGeneration: "50000000-0000-4000-8000-000000000001", type: "response", payload: { ok: true, requestType: "room.replay", data: page, replayed: false } };
        expect(() => assertEnvelopeSize(envelope)).not.toThrow();
        expect(new TextEncoder().encode(JSON.stringify(envelope)).byteLength).toBeLessThanOrEqual(MAX_IPC_BYTES);
        expect(page.nextRoomSeq).toBeGreaterThan(cursor);
        collected.push(...page.events.map((event) => event.roomSeq));
        cursor = page.nextRoomSeq;
        hasMore = page.hasMore;
      }
      expect(collected).toEqual([1, 2, 3, 4]);
    } finally {
      database.close();
    }
  });

  it("returns a snapshot from one transaction and one room read", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const baseRepositories = createRepositories(database);
      const project = baseRepositories.projects.insert({ id: "10000000-0000-4000-8000-000000000001", repositoryRoot: "/repo", gitCommonDir: "/repo/.git", displayName: "repo", headOid: "a".repeat(40), defaultBranch: "main", createdAt: "2026-07-21T10:00:00.000Z" });
      const room = baseRepositories.rooms.insert({ id: "20000000-0000-4000-8000-000000000001", projectId: project.id, title: "A", createdAt: "2026-07-21T10:01:00.000Z" });
      createEventStore(database, baseRepositories).append({ id: "30000000-0000-4000-8000-000000000001", roomId: room.id, type: "message.posted", actor: "user", payload: { id: "40000000-0000-4000-8000-000000000001", roomId: room.id, body: "one", createdAt: "2026-07-21T10:03:00.000Z" }, createdAt: "2026-07-21T10:03:00.000Z" });

      let transactionCalls = 0;
      let roomListCalls = 0;
      const trackedDatabase: Database = {
        exec: database.exec.bind(database),
        prepare: database.prepare.bind(database),
        transaction(work) {
          transactionCalls += 1;
          return database.transaction(work);
        },
        close: database.close.bind(database)
      };
      const trackedRepositories: DomainRepositories = {
        projects: baseRepositories.projects,
        rooms: {
          ...baseRepositories.rooms,
          list() {
            roomListCalls += 1;
            return roomListCalls === 1 ? baseRepositories.rooms.list() : [];
          }
        }
      };

      const snapshot = createEventStore(trackedDatabase, trackedRepositories).snapshot();
      expect(transactionCalls).toBe(1);
      expect(roomListCalls).toBe(1);
      expect(snapshot.rooms).toEqual([room]);
      expect(snapshot.roomCursors).toEqual({ [room.id]: 1 });
    } finally {
      database.close();
    }
  });

  it("rejects a payload addressed to another room without storing an event", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const repositories = createRepositories(database);
      const project = repositories.projects.insert({ id: "10000000-0000-4000-8000-000000000001", repositoryRoot: "/repo", gitCommonDir: "/repo/.git", displayName: "repo", headOid: "a".repeat(40), defaultBranch: "main", createdAt: "2026-07-21T10:00:00.000Z" });
      const room = repositories.rooms.insert({ id: "20000000-0000-4000-8000-000000000001", projectId: project.id, title: "A", createdAt: "2026-07-21T10:01:00.000Z" });
      const events = createEventStore(database, repositories);

      expect(() => events.append({ id: "30000000-0000-4000-8000-000000000001", roomId: room.id, type: "message.posted", actor: "user", payload: { id: "40000000-0000-4000-8000-000000000001", roomId: "20000000-0000-4000-8000-000000000002", body: "wrong room", createdAt: "2026-07-21T10:03:00.000Z" }, createdAt: "2026-07-21T10:03:00.000Z" })).toThrow(/payload roomId/);
      expect(database.prepare("SELECT count(*) AS count FROM room_events").get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("commits a mutation once and rejects key reuse with a different hash", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const dedupe = createIdempotencyStore(database, () => "2026-07-21T10:00:00.000Z");
      let writes = 0;
      const command = { idempotencyKey: "same-key", requestType: "project.addExisting", requestHash: "hash-a", workerGeneration: "50000000-0000-4000-8000-000000000001" };
      const first = dedupe.execute(command, ProjectSchema, () => { writes += 1; return { id: "10000000-0000-4000-8000-000000000001", repositoryRoot: "/repo", gitCommonDir: "/repo/.git", displayName: "repo", headOid: "a".repeat(40), defaultBranch: "main", createdAt: "2026-07-21T10:00:00.000Z" }; });
      const replay = dedupe.execute(command, ProjectSchema, () => { writes += 1; throw new Error("must not run"); });
      expect({ writes, first: first.replayed, replay: replay.replayed }).toEqual({ writes: 1, first: false, replay: true });
      expect(() => dedupe.execute({ ...command, requestHash: "hash-b" }, ProjectSchema, () => first.value)).toThrow(IdempotencyConflictError);
    } finally {
      database.close();
    }
  });

  it("looks up only completed schema-validating durable results", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const dedupe = createIdempotencyStore(database, () => "2026-07-21T10:00:00.000Z");
      const command = { idempotencyKey: "replay-key", requestType: "project.addExisting", requestHash: "hash-a", workerGeneration: "50000000-0000-4000-8000-000000000001" };
      const project = { id: "10000000-0000-4000-8000-000000000001", repositoryRoot: "/repo", gitCommonDir: "/repo/.git", displayName: "repo", headOid: "a".repeat(40), defaultBranch: "main", createdAt: "2026-07-21T10:00:00.000Z" };

      expect(dedupe.replay(command, ProjectSchema)).toBeUndefined();
      dedupe.execute(command, ProjectSchema, () => project);
      expect(dedupe.replay(command, ProjectSchema)).toEqual({ value: project, replayed: true });
      expect(() => dedupe.replay({ ...command, requestHash: "hash-b" }, ProjectSchema)).toThrow(IdempotencyConflictError);

      database.prepare("INSERT INTO idempotency_records(idempotency_key, request_type, request_hash, worker_generation, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)").run("pending-key", command.requestType, command.requestHash, command.workerGeneration, project.createdAt);
      expect(() => dedupe.replay({ ...command, idempotencyKey: "pending-key" }, ProjectSchema)).toThrow(/Incomplete/);
    } finally {
      database.close();
    }
  });
});
