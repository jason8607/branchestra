import { describe, expect, it, vi } from "vitest";
import { ProviderSessionService } from "../../../src/worker/providers/provider-session-service";

const saved = { runId: "run-1", provider: "codex" as const, providerSessionId: "thread-1", contextHash: "a".repeat(64), lastProviderSeq: 4, resumeState: "resumable" as const, updatedAt: "2026-07-21T00:00:00.000Z" };
describe("ProviderSessionService", () => {
  it("resumes the persisted Provider session", async () => {
    const adapter = { resumeRun: vi.fn().mockResolvedValue({ runId: "run-1" }), startRun: vi.fn() };
    const service = new ProviderSessionService({ repository: { requireResumableSession: () => saved, upsertSession: vi.fn(), markSessionReplaced: vi.fn() }, now: () => "2026-07-21T01:00:00.000Z", classifyResumeUnavailable: () => true });
    const result = await service.resumeOrRecover({ interruptedRunId: "run-1", adapter, toResumeRequest: (session) => ({ providerSessionId: session.providerSessionId, contextHash: session.contextHash }), buildRecoveryBrief: vi.fn(), buildFreshContext: vi.fn(), toRecoveryStartRequest: vi.fn() });
    expect(result.strategy).toBe("resumed_session");
    expect(adapter.resumeRun).toHaveBeenCalledWith({ providerSessionId: "thread-1", contextHash: "a".repeat(64) });
  });
  it("starts once with a recovery brief when resume is unavailable", async () => {
    const adapter = { resumeRun: vi.fn().mockRejectedValue(new Error("gone")), startRun: vi.fn().mockResolvedValue({ runId: "run-2" }) };
    const mark = vi.fn();
    const service = new ProviderSessionService({ repository: { requireResumableSession: () => saved, upsertSession: vi.fn(), markSessionReplaced: mark }, now: () => "2026-07-21T01:00:00.000Z", classifyResumeUnavailable: () => true });
    const result = await service.resumeOrRecover({ interruptedRunId: "run-1", adapter, toResumeRequest: vi.fn(), buildRecoveryBrief: async () => ({ interruptedRunId: "run-1", providerSessionId: "thread-1", lastDurableProviderSeq: 4, lastContextHash: saved.contextHash, latestCheckpointOid: null, diffSummary: null, testSummaries: [], instruction: "Do not replay external side effects. Continue from the durable state below." }), buildFreshContext: async () => ({ hash: "fresh" }), toRecoveryStartRequest: (_context, brief) => ({ recoveryBrief: brief.instruction }) });
    expect(result.strategy).toBe("new_session_with_brief");
    expect(adapter.startRun).toHaveBeenCalledTimes(1);
    expect(mark).toHaveBeenCalledWith("run-1", "run-2", "2026-07-21T01:00:00.000Z");
  });
});
