import { expect, it } from "vitest";
import { redactText, redactValue } from "../../../src/worker/diagnostics/redactor";

it("redacts tokens, authorization headers, credentials, and sensitive environment fields", () => {
  expect(redactText("Authorization: Bearer sk-ant-secret\nToken ghp_123456789012345678901234567890123456"))
    .toBe("Authorization: [REDACTED]\nToken [REDACTED]");
  expect(redactValue({ PATH: "/opt/homebrew/bin", ANTHROPIC_API_KEY: "secret", nested: { password: "secret" } }))
    .toEqual({ PATH: "/opt/homebrew/bin", ANTHROPIC_API_KEY: "[REDACTED]", nested: { password: "[REDACTED]" } });
});
