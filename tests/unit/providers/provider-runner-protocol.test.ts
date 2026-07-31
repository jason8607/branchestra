import { describe, expect, it } from "vitest";
import { ProviderRunnerCommandSchema, ProviderRunnerMessageSchema } from "../../../src/shared/contracts/provider-runner";

describe("provider runner protocol", () => {
  it("requires run IDs and canonical executable paths", () => {
    expect(() => ProviderRunnerCommandSchema.parse({ type: "run.start", provider: "codex" })).toThrow();
  });
  it("rejects oversized JSONL before parsing", async () => {
    const { decodeJsonLine } = await import("../../../src/provider-runner/jsonl-channel");
    expect(() => decodeJsonLine("x".repeat(1_048_577), ProviderRunnerMessageSchema)).toThrow("Provider runner line exceeds 1048576 bytes");
  });
});
