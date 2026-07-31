import { gunzipSync } from "node:zlib";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { exportDiagnosticBundle } from "../../src/worker/diagnostics/export-bundle";

it("exports only redacted metadata with owner-only permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "branchestra-diagnostics-"));
  const destination = join(root, "branchestra-diagnostics.json.gz");
  await exportDiagnosticBundle({
    appVersion: "0.1.0", platform: { os: "darwin", arch: "arm64", electron: "43.1.1", node: "24.18.0" },
    providerHealth: { provider: "codex", authToken: "sk-ant-secret" }, taskStateCounts: { Working: 1 },
    recentErrors: [{ message: "Authorization: Bearer sk-ant-secret", sourceBody: "[excluded by caller]" }],
  }, destination);
  expect((await stat(destination)).mode & 0o777).toBe(0o600);
  const decoded = gunzipSync(await readFile(destination)).toString("utf8");
  expect(decoded).not.toContain("sk-ant-secret");
  expect(decoded).toContain("[REDACTED]");
});
