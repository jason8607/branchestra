import { describe, expect, it } from "vitest";
import { resolveRendererLocation } from "../../src/main/renderer-location";

describe("renderer location", () => {
  it("ignores ELECTRON_RENDERER_URL in packaged builds", () => {
    expect(resolveRendererLocation({
      isPackaged: true,
      rendererEntry: "/app/out/renderer/index.html",
      developmentUrl: "https://evil.example/app"
    })).toEqual({ kind: "file", url: "file:///app/out/renderer/index.html" });
  });

  it.each([
    "https://evil.example",
    "http://user:pass@localhost:5173",
    "file:///tmp/evil.html",
    "http://localhost:5173/path",
    "http://127.0.0.1:5173/?query=1"
  ])("rejects untrusted development renderer URL %s", (developmentUrl) => {
    expect(() => resolveRendererLocation({
      isPackaged: false,
      rendererEntry: "/app/out/renderer/index.html",
      developmentUrl
    })).toThrow(/trusted loopback/i);
  });

  it.each(["http://localhost:5173", "http://127.0.0.1:5173", "https://[::1]:5173"])(
    "allows exact loopback Vite origin %s",
    (developmentUrl) => {
      expect(resolveRendererLocation({
        isPackaged: false,
        rendererEntry: "/app/out/renderer/index.html",
        developmentUrl
      })).toEqual({ kind: "url", url: `${developmentUrl}/` });
    }
  );
});
