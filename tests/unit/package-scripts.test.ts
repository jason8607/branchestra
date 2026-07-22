import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("stable package scripts", () => {
  it("builds fresh Electron output before the Playwright E2E suite", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts["test:e2e"]).toBe("pnpm build && playwright test");
    expect(packageJson.scripts.build).toBe("electron-vite build");
  });
});
