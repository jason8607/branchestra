import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeClaudeEvent } from "../../../src/worker/providers/normalization/claude-event";

const run = { runId: "019f842d-e19a-7cc1-9d73-4d287bf40558", providerSeq: 0, occurredAt: "2026-07-21T10:00:00.000Z" };
describe("Claude event contract", () => {
  it("captures session_id from system init and result fixtures", () => {
    const events = readFileSync("tests/fixtures/providers/claude/success.jsonl", "utf8").trim().split("\n").flatMap((line) => normalizeClaudeEvent(JSON.parse(line), run));
    expect(events.filter((event) => event.type === "session.started").map((event) => event.sessionId)).toEqual(["claude-session-1", "claude-session-1"]);
  });
  it("allows unknown fields but rejects missing critical session semantics", () => {
    expect(normalizeClaudeEvent(JSON.parse(readFileSync("tests/fixtures/providers/claude/unknown-fields.jsonl", "utf8")), run).length).toBeGreaterThan(0);
    expect(() => normalizeClaudeEvent(JSON.parse(readFileSync("tests/fixtures/providers/claude/missing-session.jsonl", "utf8")), run)).toThrow("Claude result is missing session_id");
  });
});
