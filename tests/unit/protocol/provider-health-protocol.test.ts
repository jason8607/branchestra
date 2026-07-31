import { describe, expect, it } from "vitest";
import { RendererRequestEnvelopeSchema, WorkerRequestEnvelopeSchema } from "../../../src/shared/contracts/protocol";

describe("provider health protocol", () => {
  it("lets Renderer request a picker without supplying a path", () => {
    expect(RendererRequestEnvelopeSchema.parse({
      v: 1, requestId: "11111111-1111-4111-8111-111111111111", idempotencyKey: "pick-codex-1",
      workerGeneration: "019f842d-e19a-7cc1-9d73-4d287bf40558", type: "provider.pickExecutable", payload: { provider: "codex" },
    }).payload).toEqual({ provider: "codex" });
  });

  it("rejects a forged Renderer-selected path", () => {
    expect(() => RendererRequestEnvelopeSchema.parse({
      v: 1, requestId: "22222222-2222-4222-8222-222222222222", idempotencyKey: "forged",
      workerGeneration: "019f842d-e19a-7cc1-9d73-4d287bf40558", type: "provider.executableSelected",
      payload: { provider: "codex", selectedPath: "/tmp/fake-codex" },
    })).toThrow();
  });

  it("accepts the Main-injected worker command", () => {
    expect(WorkerRequestEnvelopeSchema.parse({
      v: 1, requestId: "33333333-3333-4333-8333-333333333333", idempotencyKey: "selected-codex-1",
      workerGeneration: "019f842d-e19a-7cc1-9d73-4d287bf40558", type: "provider.executableSelected",
      payload: { provider: "codex", selectedPath: "/opt/homebrew/bin/codex" },
    }).type).toBe("provider.executableSelected");
  });
});
