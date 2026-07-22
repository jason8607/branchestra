import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import config from "../../electron.vite.config";
import { createWindowOptions } from "../../src/main/window-options";

interface PreloadRollupOptions {
  external?: unknown;
  output?: unknown;
}

describe("Electron/Vite shell configuration", () => {
  it("configures a bundled CommonJS sandbox preload with only Electron external", () => {
    expect(config.main?.plugins).toHaveLength(1);
    expect(config.preload?.plugins ?? []).toHaveLength(0);
    expect(config.renderer?.root).toBe(resolve("src/renderer"));
    expect(config.preload?.build?.externalizeDeps).toBe(false);
    const rollup = config.preload?.build?.rollupOptions as PreloadRollupOptions | undefined;
    expect(rollup?.external).toEqual(["electron"]);
    expect(rollup?.output).toMatchObject({ format: "cjs", entryFileNames: "[name].js" });
  });

  it("emits a sandbox-compatible .js preload without ESM or Node built-ins", () => {
    execFileSync("pnpm", ["build"], { cwd: resolve("."), stdio: "pipe" });
    const preloadPath = resolve("out/preload/index.js");
    expect(existsSync(preloadPath)).toBe(true);
    const source = readFileSync(preloadPath, "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toContain("node:crypto");
    const externalModules = [...source.matchAll(/require\(["']([^"']+)["']\)/g)]
      .map((match) => match[1]);
    expect([...new Set(externalModules)]).toEqual(["electron"]);
    expect(createWindowOptions(preloadPath).webPreferences?.sandbox).toBe(true);
  });
});
