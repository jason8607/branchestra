import {
  WorkerResponseEnvelopeSchema,
  type WorkerCommand,
  type WorkerRequestEnvelope,
  type WorkerResponseEnvelope
} from "../../shared/contracts/protocol";
import { NotFoundError } from "../domain/errors";
import { GitRepositoryError } from "../git/inspect-repository";
import { IdempotencyConflictError } from "../storage/idempotency-store";
import {
  createCommandContext,
  type AnyCommandHandler,
  type CommandHandler,
  type HandlerResult
} from "./command-handler";

type ErrorCode = "STALE_WORKER_GENERATION" | "IDEMPOTENCY_CONFLICT" | "GIT_INVALID" | "NOT_FOUND" | "INTERNAL";

export function createWorkerRouter(options: {
  workerGeneration: string;
  handlers: readonly AnyCommandHandler[];
}): (envelope: WorkerRequestEnvelope) => Promise<WorkerResponseEnvelope> {
  const handlers = new Map<WorkerCommand["type"], AnyCommandHandler>();
  for (const handler of options.handlers) {
    if (handlers.has(handler.type)) {
      throw new Error(`Duplicate worker handler registration: ${handler.type}`);
    }
    handlers.set(handler.type, handler);
  }

  return async (envelope) => {
    const fail = (code: ErrorCode, message: string): WorkerResponseEnvelope => WorkerResponseEnvelopeSchema.parse({
      v: 1,
      requestId: envelope.requestId,
      idempotencyKey: envelope.idempotencyKey,
      workerGeneration: options.workerGeneration,
      type: "response",
      payload: { ok: false, requestType: envelope.type, code, message }
    });

    if (envelope.workerGeneration !== options.workerGeneration) {
      return fail("STALE_WORKER_GENERATION", "Worker generation changed; refresh snapshot before retrying");
    }

    const handler = handlers.get(envelope.type) as CommandHandler<WorkerCommand["type"]> | undefined;
    if (!handler) return fail("INTERNAL", `No worker handler registered for ${envelope.type}`);

    try {
      const result: HandlerResult = await handler.handle(
        commandFromEnvelope(envelope),
        createCommandContext(envelope)
      );
      return WorkerResponseEnvelopeSchema.parse({
        v: 1,
        requestId: envelope.requestId,
        idempotencyKey: envelope.idempotencyKey,
        workerGeneration: options.workerGeneration,
        type: "response",
        payload: {
          ok: true,
          requestType: envelope.type,
          data: result.data,
          replayed: result.replayed
        }
      });
    } catch (error) {
      if (error instanceof IdempotencyConflictError) return fail("IDEMPOTENCY_CONFLICT", error.message);
      if (error instanceof GitRepositoryError) return fail("GIT_INVALID", error.message);
      if (error instanceof NotFoundError) {
        return fail("NOT_FOUND", error.message);
      }
      return fail("INTERNAL", "Worker command failed");
    }
  };
}

function commandFromEnvelope(envelope: WorkerRequestEnvelope): WorkerCommand {
  switch (envelope.type) {
    case "state.getSnapshot":
      return { type: envelope.type, payload: envelope.payload };
    case "room.replay":
      return { type: envelope.type, payload: envelope.payload };
    case "project.addExisting":
      return { type: envelope.type, payload: envelope.payload };
    case "room.create":
      return { type: envelope.type, payload: envelope.payload };
    case "message.post":
      return { type: envelope.type, payload: envelope.payload };
    case "worker.prepareQuit":
      return { type: envelope.type, payload: envelope.payload };
  }
}
