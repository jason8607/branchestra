import { describe, expect, it } from "vitest";
import { createWindowOptions } from "../../src/main/window-options";

describe("createWindowOptions", () => {
  it("keeps the renderer isolated from Node and webviews", () => {
    const options = createWindowOptions("/app/preload.js");
    expect(options.webPreferences).toMatchObject({
      preload: "/app/preload.js",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false
    });
  });
});
