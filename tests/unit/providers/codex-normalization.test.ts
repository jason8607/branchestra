import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeCodexEvent } from "../../../src/worker/providers/normalization/codex-event";

const run = { runId: "019f842d-e19a-7cc1-9d73-4d287bf40558", providerSeq: 0, occurredAt: "2026-07-21T10:00:00.000Z" };
describe("Codex event contract", () => {
  it("emits item snapshots and no synthetic deltas", () => {
    const events = readFileSync("tests/fixtures/providers/codex/success.jsonl", "utf8").trim().split("\n").flatMap((line) => normalizeCodexEvent(JSON.parse(line), run));
    expect(events.some((event) => event.type === "session.started")).toBe(true);
    expect(events.filter((event) => event.type === "item.snapshot")).toHaveLength(2);
    expect(events.some((event) => event.type === "assistant.delta")).toBe(false);
  });
  it("turns permission failure into approval then terminal failure", () => {
    const events = normalizeCodexEvent(JSON.parse(readFileSync("tests/fixtures/providers/codex/permission-failure.jsonl", "utf8")), run);
    expect(events.map((event) => event.type)).toEqual(["approval.required", "run.failed"]);
  });
});
