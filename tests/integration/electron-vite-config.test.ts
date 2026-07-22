import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import config from "../../electron.vite.config";

describe("Electron/Vite shell configuration", () => {
  it("wires isolated main and preload builds to the Renderer root", () => {
    expect(config.main?.plugins).toHaveLength(1);
    expect(config.preload?.plugins).toHaveLength(1);
    expect(config.renderer?.root).toBe(resolve("src/renderer"));
  });
});
