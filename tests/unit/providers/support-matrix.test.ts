import { describe, expect, it } from "vitest";
import { evaluateSupport } from "../../../src/worker/providers/support-matrix";

describe("provider support matrix", () => {
  it.each([
    ["claude", "0.3.216", "2.1.206", "arm64"],
    ["claude", "0.3.216", "2.1.206", "x64"],
    ["codex", "0.144.6", "0.144.6", "arm64"],
    ["codex", "0.144.6", "0.144.6", "x64"],
  ] as const)("accepts the reviewed %s tuple", (provider, sdkVersion, cliVersion, architecture) => {
    expect(evaluateSupport({ provider, sdkVersion, cliVersion, architecture })).toEqual({ supported: true });
  });

  it("fails closed on an unreviewed CLI patch", () => {
    expect(evaluateSupport({ provider: "codex", sdkVersion: "0.144.6", cliVersion: "0.144.7", architecture: "arm64" }))
      .toEqual({ supported: false, reason: "Unsupported Codex CLI 0.144.7 for SDK 0.144.6 on arm64" });
  });
});
