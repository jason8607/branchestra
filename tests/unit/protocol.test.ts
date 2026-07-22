import { describe, expect, it } from "vitest";
import {
  MAX_IPC_BYTES,
  PROTOCOL_VERSION,
  ZERO_WORKER_GENERATION,
  assertEnvelopeSize,
  parseEnvelope,
  RendererRequestEnvelopeSchema,
  WorkerRequestEnvelopeSchema
} from "../../src/shared/contracts/protocol";

const metadata = {
  v: PROTOCOL_VERSION,
  requestId: "11111111-1111-4111-8111-111111111111",
  idempotencyKey: "command-1",
  workerGeneration: "22222222-2222-4222-8222-222222222222"
} as const;

describe("IPC contracts", () => {
  it("accepts an exact renderer room command", () => {
    expect(RendererRequestEnvelopeSchema.parse({
      ...metadata,
      type: "room.create",
      payload: { projectId: "33333333-3333-4333-8333-333333333333", title: "Ideas" }
    }).type).toBe("room.create");
  });

  it("does not expose a renderer command carrying a filesystem path", () => {
    expect(() => RendererRequestEnvelopeSchema.parse({
      ...metadata,
      type: "project.addExisting",
      payload: { selectedPath: "/private/repository" }
    })).toThrow();
  });

  it("allows the zero generation only for renderer snapshot bootstrap", () => {
    expect(RendererRequestEnvelopeSchema.parse({
      ...metadata,
      workerGeneration: ZERO_WORKER_GENERATION,
      type: "state.getSnapshot",
      payload: {}
    }).type).toBe("state.getSnapshot");
    expect(() => WorkerRequestEnvelopeSchema.parse({
      ...metadata,
      workerGeneration: ZERO_WORKER_GENERATION,
      type: "message.post",
      payload: { roomId: metadata.requestId, body: "unsafe" }
    })).toThrow();
  });

  it("rejects unknown keys and envelopes over 65536 encoded bytes", () => {
    expect(() => RendererRequestEnvelopeSchema.parse({
      ...metadata,
      type: "project.pickExisting",
      payload: {},
      extra: true
    })).toThrow();
    expect(() => assertEnvelopeSize({ body: "x".repeat(MAX_IPC_BYTES) })).toThrow(/65536/);
  });

  it("enforces the byte boundary before schema parsing in the centralized parser", () => {
    expect(() => parseEnvelope(RendererRequestEnvelopeSchema, { body: "x".repeat(MAX_IPC_BYTES) }))
      .toThrow("IPC envelope exceeds");
  });
});
