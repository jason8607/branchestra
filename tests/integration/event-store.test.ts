import { describe, expect, it } from "vitest";
import { ProjectSchema } from "../../src/shared/contracts/domain";
import { openDatabase } from "../../src/worker/storage/database";
import { createEventStore } from "../../src/worker/storage/event-store";
import {
  createIdempotencyStore,
  IdempotencyConflictError
} from "../../src/worker/storage/idempotency-store";
import { runMigrations } from "../../src/worker/storage/migrations";
import { createRepositories } from "../../src/worker/storage/repositories";

describe("event storage", () => {
  it("allocates room_seq per room and replays after a cursor", () => {
    const database = openDatabase(":memory:");
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
    database.close();
  });

  it("commits a mutation once and rejects key reuse with a different hash", () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const dedupe = createIdempotencyStore(database, () => "2026-07-21T10:00:00.000Z");
    let writes = 0;
    const command = { idempotencyKey: "same-key", requestType: "project.addExisting", requestHash: "hash-a", workerGeneration: "50000000-0000-4000-8000-000000000001" };
    const first = dedupe.execute(command, ProjectSchema, () => { writes += 1; return { id: "10000000-0000-4000-8000-000000000001", repositoryRoot: "/repo", gitCommonDir: "/repo/.git", displayName: "repo", headOid: "a".repeat(40), defaultBranch: "main", createdAt: "2026-07-21T10:00:00.000Z" }; });
    const replay = dedupe.execute(command, ProjectSchema, () => { writes += 1; throw new Error("must not run"); });
    expect({ writes, first: first.replayed, replay: replay.replayed }).toEqual({ writes: 1, first: false, replay: true });
    expect(() => dedupe.execute({ ...command, requestHash: "hash-b" }, ProjectSchema, () => first.value)).toThrow(IdempotencyConflictError);
    database.close();
  });
});
