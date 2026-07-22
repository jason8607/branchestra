import type { BranchestraApi } from "../shared/contracts/renderer-api";
import {
  RendererRequestEnvelopeSchema,
  WorkerEventEnvelopeSchema,
  WorkerResponseEnvelopeSchema,
  ZERO_WORKER_GENERATION,
  assertEnvelopeSize,
  parseEnvelope
} from "../shared/contracts/protocol";

export interface PreloadTransport {
  invoke(channel: "branchestra:request", value: unknown): Promise<unknown>;
  on(channel: "branchestra:event", listener: (value: unknown) => void): () => void;
}

export type RequestIdGenerator = () => string;

export function createPreloadApi(
  transport: PreloadTransport,
  nextRequestId: RequestIdGenerator = () => globalThis.crypto.randomUUID()
): BranchestraApi {
  let generation = ZERO_WORKER_GENERATION;
  const api: BranchestraApi = {
    async request(command) {
      const requestGeneration = generation;
      const envelope = RendererRequestEnvelopeSchema.parse({
        v: 1,
        requestId: nextRequestId(),
        idempotencyKey: command.idempotencyKey,
        workerGeneration: requestGeneration,
        type: command.type,
        payload: command.payload
      });
      assertEnvelopeSize(envelope);
      const response = parseEnvelope(WorkerResponseEnvelopeSchema,
        await transport.invoke("branchestra:request", envelope)
      );
      if (
        response.requestId !== envelope.requestId
        || response.idempotencyKey !== envelope.idempotencyKey
        || response.payload.requestType !== envelope.type
      ) {
        throw new Error("Renderer response correlation mismatch");
      }
      const isBootstrapSnapshot = envelope.type === "state.getSnapshot"
        && requestGeneration === ZERO_WORKER_GENERATION;
      if (!isBootstrapSnapshot && response.workerGeneration !== requestGeneration) {
        throw new Error("Renderer response generation mismatch");
      }
      if (
        (isBootstrapSnapshot && generation !== ZERO_WORKER_GENERATION
          && response.workerGeneration !== generation)
        || (!isBootstrapSnapshot && generation !== requestGeneration)
      ) {
        throw new Error("Renderer response generation is obsolete");
      }
      generation = response.workerGeneration;
      return response;
    },
    subscribe(listener) {
      return transport.on("branchestra:event", (raw) => {
        const event = parseEnvelope(WorkerEventEnvelopeSchema, raw);
        generation = event.workerGeneration;
        listener(event);
      });
    }
  };
  return Object.freeze(api);
}
