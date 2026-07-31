import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { redactText, redactValue } from "../../../src/worker/diagnostics/redactor";
import { RotatingLog } from "../../../src/worker/diagnostics/rotating-log";

it("redacts tokens, authorization headers, credentials, and sensitive environment fields", () => {
  expect(redactText("Authorization: Bearer sk-ant-secret\nToken ghp_123456789012345678901234567890123456"))
    .toBe("Authorization: [REDACTED]\nToken [REDACTED]");
  expect(redactValue({ PATH: "/opt/homebrew/bin", ANTHROPIC_API_KEY: "secret", nested: { password: "secret" } }))
    .toEqual({ PATH: "/opt/homebrew/bin", ANTHROPIC_API_KEY: "[REDACTED]", nested: { password: "[REDACTED]" } });
});

it("writes secret-redacted owner-only local logs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "branchestra-log-"));
  const path = join(directory, "worker.jsonl");
  await new RotatingLog(path).write({
    scope: "worker.request",
    Authorization: "Bearer sk-ant-super-secret",
    code: "INTERNAL"
  });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  const text = await readFile(path, "utf8");
  expect(text).toContain("[REDACTED]");
  expect(text).not.toContain("sk-ant-super-secret");
});
