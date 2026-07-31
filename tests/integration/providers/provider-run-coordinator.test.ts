import { describe, expect, it, vi } from "vitest";
import { ProviderRunCoordinator } from "../../../src/worker/providers/provider-run-coordinator";

describe("ProviderRunCoordinator", () => {
  it("commits the raw event before normalization or timeline publication", async () => {
    const order: string[] = [];
    const repository = { appendRawEvent: vi.fn(async () => { order.push("raw"); return true; }), saveSession: vi.fn(async () => { order.push("session"); }) };
    const normalizer = vi.fn(() => {
      order.push("normalize");
      return [{ type: "session.started" as const, runId: "019f842d-e19a-7cc1-9d73-4d287bf40558", provider: "codex" as const, providerSeq: 0, occurredAt: "2026-07-21T10:00:00.000Z", sessionId: "thread-1" }];
    });
    const publish = vi.fn(async () => { order.push("publish"); });
    const coordinator = new ProviderRunCoordinator({ repository, normalizer, publish, toolBridge: {} as never });
    await coordinator.acceptRunnerMessage({ type: "provider.raw", runId: "019f842d-e19a-7cc1-9d73-4d287bf40558", providerSeq: 0, receivedAt: "2026-07-21T10:00:00.000Z", payload: { type: "thread.started", thread_id: "thread-1" } });
    expect(order).toEqual(["raw", "normalize", "session", "publish"]);
  });

  it("does not republish a duplicate provider sequence", async () => {
    const publish = vi.fn();
    const coordinator = new ProviderRunCoordinator({ repository: { appendRawEvent: async () => false, saveSession: async () => undefined }, normalizer: vi.fn(() => []), publish, toolBridge: {} as never });
    await coordinator.acceptRunnerMessage({ type: "provider.raw", runId: "019f842d-e19a-7cc1-9d73-4d287bf40558", providerSeq: 2, receivedAt: "2026-07-21T10:00:00.000Z", payload: {} });
    expect(publish).not.toHaveBeenCalled();
  });
});
