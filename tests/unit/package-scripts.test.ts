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

  it("provides an arm64 private-local package that verifies its unpacked app", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const script = packageJson.scripts["package:local"];
    expect(script).toContain("BRANCHESTRA_BUILD_PRIVATE_LOCAL_PROVIDERS=1");
    expect(script).toContain("CSC_IDENTITY_AUTO_DISCOVERY=false");
    expect(script).toContain("--mac --arm64");
    expect(script).toContain("verify:package");
    expect(script).not.toContain("package:mac:arm64");
  });
});
