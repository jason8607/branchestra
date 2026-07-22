import { describe, expect, it, vi } from "vitest";
import { GitRepositoryError } from "../../src/worker/git/inspect-repository";
import { IdempotencyConflictError } from "../../src/worker/storage/idempotency-store";
import type { CommandHandler } from "../../src/worker/protocol/command-handler";
import { createWorkerRouter } from "../../src/worker/protocol/worker-router";

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
  it("rejects a stale generation before invoking a handler", async () => {
    const handle = vi.fn(() => ({ data: { projects: [], rooms: [], roomCursors: {} }, replayed: false }));
    const handler: CommandHandler<"state.getSnapshot"> = { type: "state.getSnapshot", handle };
    const route = createWorkerRouter({ workerGeneration: activeGeneration, handlers: [handler] });
    const response = await route({ ...request, workerGeneration: "50000000-0000-4000-8000-000000000002" });
    expect(handle).not.toHaveBeenCalled();
    expect(response).toMatchObject({ requestId: request.requestId, workerGeneration: activeGeneration, payload: { ok: false, code: "STALE_WORKER_GENERATION" } });
  });

  it("dispatches the exact command and echoes request correlation", async () => {
    const handler: CommandHandler<"state.getSnapshot"> = {
      type: "state.getSnapshot",
      handle: vi.fn(() => ({ data: { projects: [], rooms: [], roomCursors: {} }, replayed: false }))
    };
    const route = createWorkerRouter({ workerGeneration: activeGeneration, handlers: [handler] });
    const response = await route(request);
    expect(handler.handle).toHaveBeenCalledWith({ type: request.type, payload: request.payload }, expect.objectContaining({ requestId: request.requestId, idempotencyKey: request.idempotencyKey, workerGeneration: activeGeneration }));
    expect(response).toMatchObject({ v: 1, requestId: request.requestId, idempotencyKey: request.idempotencyKey, workerGeneration: activeGeneration, type: "response", payload: { ok: true, requestType: "state.getSnapshot", replayed: false } });
  });

  it.each([
    [new IdempotencyConflictError("Idempotency key conflict: snapshot-1"), "IDEMPOTENCY_CONFLICT", "Idempotency key conflict: snapshot-1"],
    [new GitRepositoryError("Selected directory is not a Git repository with a valid HEAD"), "GIT_INVALID", "Selected directory is not a Git repository with a valid HEAD"],
    [new Error("Project not found: project-1"), "NOT_FOUND", "Project not found: project-1"],
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
