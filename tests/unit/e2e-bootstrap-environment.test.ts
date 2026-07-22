import { describe, expect, it } from "vitest";
import { resolveE2EEnvironment } from "../../src/main/bootstrap";
import { createFixedProjectDialog } from "../../src/main/dialog/project-dialog";

describe("E2E Main bootstrap environment", () => {
  it.each([undefined, "", "0", "true", "01"])(
    "ignores injected paths in production when the flag is %s",
    (flag) => {
      expect(resolveE2EEnvironment({
        BRANCHESTRA_E2E: flag,
        BRANCHESTRA_E2E_USER_DATA: "/tmp/ignored-user-data",
        BRANCHESTRA_E2E_PROJECT_PATH: "/tmp/ignored-project"
      })).toBeNull();
    }
  );

  it.each([
    [undefined, "/tmp/project"],
    ["", "/tmp/project"],
    ["   ", "/tmp/project"],
    ["/tmp/user-data", undefined],
    ["/tmp/user-data", ""],
    ["/tmp/user-data", "   "]
  ])("rejects an enabled E2E launch without two nonempty paths", (userDataPath, projectPath) => {
    expect(() => resolveE2EEnvironment({
      BRANCHESTRA_E2E: "1",
      BRANCHESTRA_E2E_USER_DATA: userDataPath,
      BRANCHESTRA_E2E_PROJECT_PATH: projectPath
    })).toThrow("E2E requires nonempty user-data and project paths");
  });

  it("returns both Main-only paths only for the exact enabled flag", () => {
    expect(resolveE2EEnvironment({
      BRANCHESTRA_E2E: "1",
      BRANCHESTRA_E2E_USER_DATA: "/tmp/user-data",
      BRANCHESTRA_E2E_PROJECT_PATH: "/tmp/project"
    })).toEqual({ userDataPath: "/tmp/user-data", projectPath: "/tmp/project" });
  });
});

describe("fixed project dialog", () => {
  it("always returns the Main-selected project path", async () => {
    await expect(
      createFixedProjectDialog("/tmp/project").pickExistingProject({} as never)
    ).resolves.toBe("/tmp/project");
  });

  it("rejects an empty selected path during Main bootstrap", () => {
    expect(() => createFixedProjectDialog("")).toThrow("E2E project path is empty");
  });
});
