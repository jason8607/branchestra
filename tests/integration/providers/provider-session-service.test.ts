import { describe, expect, it, vi } from "vitest";
import { ProviderSessionService } from "../../../src/worker/providers/provider-session-service";
import { ProviderRepository } from "../../../src/worker/storage/provider-repository";
import { openTestDatabase } from "../../fixtures/test-database";

describe("ProviderSessionService SQLite recovery", () => {
  it("reopens SQLite and resumes the persisted Provider ID", async () => {
    const opened = openTestDatabase();
    const { records } = opened;
    opened.db.prepare(`INSERT INTO tasks(id, room_id, project_id, request_event_id, request_text, lead_provider, target_ref, base_oid, state,
      collaboration_rounds_used, collaboration_round_budget, human_revision_count, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 2, 0, 1, ?, ?)`).run(
      records.task.id, records.room.id, records.project.id, records.task.requestEventId, records.task.requestText,
      records.task.leadProvider, records.task.targetRef, records.task.baseOid, records.task.state, records.task.createdAt, records.task.updatedAt,
    );
    opened.db.prepare(`INSERT INTO agent_runs(id, task_id, provider, role, provider_session_id, context_version, context_hash, state, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      records.run.id, records.task.id, "codex", records.run.role, null, records.run.contextVersion,
      "a".repeat(64), records.run.state, records.run.startedAt, records.run.finishedAt,
    );
    let repository = new ProviderRepository(opened.db);
    let service = new ProviderSessionService({ repository, now: () => "2026-07-21T01:00:00.000Z", classifyResumeUnavailable: () => true });
    service.recordStarted({ runId: records.run.id, provider: "codex", providerSessionId: "thread-1", contextHash: "a".repeat(64), providerSeq: 0 });
    repository.markSessionInterrupted(records.run.id, "2026-07-21T01:01:00.000Z");
    repository.markSessionResumable(records.run.id, "2026-07-21T01:02:00.000Z");
    opened.db.close();

    const reopened = openTestDatabase(opened.path);
    repository = new ProviderRepository(reopened.db);
    service = new ProviderSessionService({ repository, now: () => "2026-07-21T01:03:00.000Z", classifyResumeUnavailable: () => true });
    const adapter = { resumeRun: vi.fn().mockResolvedValue({ runId: "resume-run" }), startRun: vi.fn() };
    const result = await service.resumeOrRecover({
      interruptedRunId: records.run.id,
      adapter,
      toResumeRequest: (saved) => ({ providerSessionId: saved.providerSessionId, contextHash: saved.contextHash }),
      buildRecoveryBrief: vi.fn(),
      buildFreshContext: vi.fn(),
      toRecoveryStartRequest: vi.fn(),
    });
    expect(result.strategy).toBe("resumed_session");
    expect(adapter.resumeRun).toHaveBeenCalledWith({ providerSessionId: "thread-1", contextHash: "a".repeat(64) });
    expect(adapter.startRun).not.toHaveBeenCalled();
    reopened.db.close();
  });
});
