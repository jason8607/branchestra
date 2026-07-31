import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("provider SDK version policy", () => {
  it("uses exact reviewed SDK versions", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@anthropic-ai/claude-agent-sdk"]).toBe("0.3.216");
    expect(pkg.dependencies["@openai/codex-sdk"]).toBe("0.144.6");
  });

  it("does not import SDK platform executables from application source", () => {
    const forbidden = [
      "@anthropic-ai/claude-agent-sdk-darwin-arm64",
      "@anthropic-ai/claude-agent-sdk-darwin-x64",
      "@openai/codex/bin",
    ];
    const source = readFileSync("src/provider-runner/sdk-factories.ts", "utf8");
    for (const moduleName of forbidden) expect(source).not.toContain(moduleName);
  });
});
