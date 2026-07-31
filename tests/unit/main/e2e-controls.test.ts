import { expect, it, vi } from "vitest";
import { installE2EControls } from "../../../src/main/testing/e2e-controls";

it("does not install Main-process controls in production", () => {
  installE2EControls({ NODE_ENV: "production" }, { forceCrashForTest: vi.fn() });
  expect(globalThis.__branchestraE2E).toBeUndefined();
});
it("installs only the internal worker crash seam under E2E", () => {
  const crash = vi.fn();
  installE2EControls({ BRANCHESTRA_E2E: "1" }, { forceCrashForTest: crash });
  globalThis.__branchestraE2E?.crashWorker();
  expect(crash).toHaveBeenCalledOnce();
  globalThis.__branchestraE2E = undefined;
});
