import { describe, expect, it, vi } from "vitest";
import { NotFoundError } from "../../src/worker/domain/errors";
import { GitRepositoryError } from "../../src/worker/git/inspect-repository";
import { GitReadError } from "../../src/worker/git/repository-inspector";
import { IdempotencyConflictError } from "../../src/worker/storage/idempotency-store";
import type { CommandHandler } from "../../src/worker/protocol/command-handler";
import { createCommandHandlers } from "../../src/worker/protocol/handlers";
import { createWorkerRouter } from "../../src/worker/protocol/worker-router";
import { SnapshotPageSchema } from "../../src/shared/contracts/domain";
import { assertEnvelopeSize } from "../../src/shared/contracts/protocol";

const activeGeneration = "50000000-0000-4000-8000-000000000001";
const request = {
  v: 1,
  requestId: "10000000-0000-4000-8000-000000000001",
  idempotencyKey: "snapshot-1",
  workerGeneration: activeGeneration,
  type: "state.getSnapshot",
  payload: {}
} as const;

describe("worker router", () => {
  it("returns every current canonical command type exactly once", () => {
    const project = {
      id: "10000000-0000-4000-8000-000000000001",
      repositoryRoot: "/repo",
      gitCommonDir: "/repo/.git",
      displayName: "repo",
      headOid: "a".repeat(40),
      defaultBranch: "main",
      createdAt: "2026-07-21T12:00:00.000Z"
    };
    const room = {
      id: "20000000-0000-4000-8000-000000000001",
      projectId: project.id,
      title: "Room",
      createdAt: "2026-07-21T12:00:00.000Z"
    };
    const event = {
      id: "30000000-0000-4000-8000-000000000001",
      roomId: room.id,
      roomSeq: 1,
      type: "message.posted" as const,
      actor: "user" as const,
      payload: {
        id: "40000000-0000-4000-8000-000000000001",
        roomId: room.id,
        body: "Message",
        createdAt: "2026-07-21T12:00:00.000Z"
      },
      createdAt: "2026-07-21T12:00:00.000Z"
    };
    const handlers = createCommandHandlers({
      projectService: { addExistingProject: async () => ({ value: project, replayed: false }) },
      roomService: {
        createRoom: () => ({ value: room, replayed: false }),
        postUserMessage: () => ({ value: event, replayed: false }),
        getSnapshot: () => ({ projects: [], rooms: [], tasks: [], roomCursors: {} }),
        replayRoom: () => ({ roomId: room.id, events: [], nextRoomSeq: 0, hasMore: false })
      },
      taskService: {
        createFromUserMessage: vi.fn(),
        decideScope: vi.fn(),
        grantAdditionalRounds: vi.fn(),
        decideScopeResult: vi.fn(),
        grantAdditionalRoundsResult: vi.fn()
      },
      prepareQuit: async () => undefined
    });

    const types = handlers.map((handler) => handler.type);
    expect(types).toEqual([
      "state.getSnapshot",
      "room.replay",
      "project.addExisting",
      "room.create",
      "message.post",
      "task.approveScope",
      "task.grantAdditionalRound",
      "worker.prepareQuit"
    ]);
    expect(new Set(types).size).toBe(types.length);
  });

  it("rejects duplicate handler registrations during construction", () => {
    const first: CommandHandler<"state.getSnapshot"> = {
      type: "state.getSnapshot",
      handle: () => ({ data: { projects: [], rooms: [], tasks: [], roomCursors: {} }, replayed: false })
    };
    const second: CommandHandler<"state.getSnapshot"> = {
      type: "state.getSnapshot",
      handle: () => ({ data: { projects: [], rooms: [], tasks: [], roomCursors: {} }, replayed: false })
    };

    expect(() => createWorkerRouter({
      workerGeneration: activeGeneration,
      handlers: [first, second]
    })).toThrow("Duplicate worker handler registration: state.getSnapshot");
  });

  it("rejects a stale generation before invoking a handler", async () => {
    const handle = vi.fn(() => ({ data: { projects: [], rooms: [], tasks: [], roomCursors: {} }, replayed: false }));
    const handler: CommandHandler<"state.getSnapshot"> = { type: "state.getSnapshot", handle };
    const route = createWorkerRouter({ workerGeneration: activeGeneration, handlers: [handler] });
    const response = await route({ ...request, workerGeneration: "50000000-0000-4000-8000-000000000002" });
    expect(handle).not.toHaveBeenCalled();
    expect(response).toMatchObject({ requestId: request.requestId, workerGeneration: activeGeneration, payload: { ok: false, code: "STALE_WORKER_GENERATION" } });
  });

  it("dispatches the exact command and echoes request correlation", async () => {
    const handler: CommandHandler<"state.getSnapshot"> = {
      type: "state.getSnapshot",
      handle: vi.fn(() => ({ data: { projects: [], rooms: [], tasks: [], roomCursors: {} }, replayed: false }))
    };
    const route = createWorkerRouter({ workerGeneration: activeGeneration, handlers: [handler] });
    const response = await route(request);
    expect(handler.handle).toHaveBeenCalledWith({ type: request.type, payload: request.payload }, expect.objectContaining({ requestId: request.requestId, idempotencyKey: request.idempotencyKey, workerGeneration: activeGeneration }));
    expect(response).toMatchObject({ v: 1, requestId: request.requestId, idempotencyKey: request.idempotencyKey, workerGeneration: activeGeneration, type: "response", payload: { ok: true, requestType: "state.getSnapshot", replayed: false } });
  });

  it("serves a large snapshot in bounded pages and rejects a skipped session cursor", async () => {
    const project = { id: "10000000-0000-4000-8000-000000000001", repositoryRoot: "/repo", gitCommonDir: "/repo/.git", displayName: "repo", headOid: "a".repeat(40), defaultBranch: "main", createdAt: "2026-07-21T12:00:00.000Z" };
    const rooms = Array.from({ length: 600 }, (_, index) => ({
      id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      projectId: project.id,
      title: `Room ${index} ${"x".repeat(100)}`,
      createdAt: "2026-07-21T12:00:00.000Z"
    }));
    const handlers = createCommandHandlers({
      projectService: { addExistingProject: async () => ({ value: project, replayed: false }) },
      roomService: {
        createRoom: () => ({ value: rooms[0]!, replayed: false }),
        postUserMessage: vi.fn(),
        getSnapshot: () => ({ projects: [project], rooms, tasks: [], roomCursors: Object.fromEntries(rooms.map((room) => [room.id, 0])) }),
        replayRoom: vi.fn()
      },
      taskService: {
        createFromUserMessage: vi.fn(),
        decideScope: vi.fn(),
        grantAdditionalRounds: vi.fn(),
        decideScopeResult: vi.fn(),
        grantAdditionalRoundsResult: vi.fn()
      },
      prepareQuit: async () => undefined
    });
    const route = createWorkerRouter({ workerGeneration: activeGeneration, handlers });
    const first = await route(request);
    expect(() => assertEnvelopeSize(first)).not.toThrow();
    if (!first.payload.ok) throw new Error("Expected snapshot page");
    const page = SnapshotPageSchema.parse(first.payload.data);
    expect(page.hasMore).toBe(true);

    const skipped = await route({
      ...request,
      requestId: "10000000-0000-4000-8000-000000000002",
      idempotencyKey: "snapshot-skipped",
      payload: { snapshotId: page.snapshotId, cursor: page.nextCursor + 1 }
    });
    expect(skipped.payload).toMatchObject({ ok: false, code: "INTERNAL" });
  });

  it.each([
    [new IdempotencyConflictError("Idempotency key conflict: snapshot-1"), "IDEMPOTENCY_CONFLICT", "Idempotency key conflict: snapshot-1"],
    [new GitRepositoryError("Selected directory is not a Git repository with a valid HEAD"), "GIT_INVALID", "Selected directory is not a Git repository with a valid HEAD"],
    [new GitReadError("REPOSITORY_IDENTITY_MISMATCH"), "GIT_INVALID", "REPOSITORY_IDENTITY_MISMATCH"],
    [new NotFoundError("Project not found: project-1"), "NOT_FOUND", "Project not found: project-1"],
    [new Error("configuration not found"), "INTERNAL", "Worker command failed"],
    [new Error("database is unavailable"), "INTERNAL", "Worker command failed"]
  ] as const)("maps %s to a stable %s response", async (error, code, message) => {
    const handler: CommandHandler<"state.getSnapshot"> = {
      type: "state.getSnapshot",
      handle: () => { throw error; }
    };
    const response = await createWorkerRouter({
      workerGeneration: activeGeneration,
      handlers: [handler]
    })(request);

    expect(response).toMatchObject({
      requestId: request.requestId,
      idempotencyKey: request.idempotencyKey,
      workerGeneration: activeGeneration,
      payload: { ok: false, requestType: request.type, code, message }
    });
  });
});
