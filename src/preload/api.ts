import { randomUUID } from "node:crypto";
import type { BranchestraApi } from "../shared/contracts/renderer-api";
import {
  RendererRequestEnvelopeSchema,
  WorkerEventEnvelopeSchema,
  WorkerResponseEnvelopeSchema,
  ZERO_WORKER_GENERATION
} from "../shared/contracts/protocol";

export interface PreloadTransport {
  invoke(channel: "branchestra:request", value: unknown): Promise<unknown>;
  on(channel: "branchestra:event", listener: (value: unknown) => void): () => void;
}

export function createPreloadApi(transport: PreloadTransport): BranchestraApi {
  let generation = ZERO_WORKER_GENERATION;
  const api: BranchestraApi = {
    async request(command) {
      const envelope = RendererRequestEnvelopeSchema.parse({
        v: 1,
        requestId: randomUUID(),
        idempotencyKey: command.idempotencyKey,
        workerGeneration: generation,
        type: command.type,
        payload: command.payload
      });
      const response = WorkerResponseEnvelopeSchema.parse(
        await transport.invoke("branchestra:request", envelope)
      );
      generation = response.workerGeneration;
      return response;
    },
    subscribe(listener) {
      return transport.on("branchestra:event", (raw) => {
        const event = WorkerEventEnvelopeSchema.parse(raw);
        generation = event.workerGeneration;
        listener(event);
      });
    }
  };
  return Object.freeze(api);
}
