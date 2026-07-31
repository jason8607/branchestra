import { describe, expect, it } from "vitest";
import type { ContextBundle } from "../../../src/shared/contracts/provider";
import { ContextRepository } from "../../../src/worker/context/context-repository";
import { ProviderRepository } from "../../../src/worker/storage/provider-repository";
import { openTestDatabase } from "../../fixtures/test-database";

function seedRun(db: ReturnType<typeof openTestDatabase>["db"], records: ReturnType<typeof openTestDatabase>["records"]): void {
  db.prepare(`INSERT INTO tasks(id, room_id, project_id, request_event_id, request_text, lead_provider, target_ref, base_oid, state,
    collaboration_rounds_used, collaboration_round_budget, human_revision_count, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 2, 0, 1, ?, ?)`).run(
    records.task.id, records.room.id, records.project.id, records.task.requestEventId, records.task.requestText,
    records.task.leadProvider, records.task.targetRef, records.task.baseOid, records.task.state, records.task.createdAt, records.task.updatedAt,
  );
  db.prepare(`INSERT INTO agent_runs(id, task_id, provider, role, provider_session_id, context_version, context_hash, state, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    records.run.id, records.task.id, records.run.provider, records.run.role, records.run.providerSessionId,
    records.run.contextVersion, records.run.contextHash, records.run.state, records.run.startedAt, records.run.finishedAt,
  );
}

describe("ContextRepository", () => {
  it("persists canonical context idempotently across reopen", () => {
    const first = openTestDatabase();
    seedRun(first.db, first.records);
    const bundle: ContextBundle = {
      version: 1, hash: "a".repeat(64), roomId: first.records.room.id, taskId: first.records.task.id, role: "lead",
      payload: {
        task: { instruction: "Implement adapters", approvedScope: "lead worktree", lead: "claude" },
        recentVerbatim: [], roomMemory: { summaryVersion: 1, summary: "Adapters", decisions: ["No API fallback"] },
        relevantHistory: [], peer: { messages: [], checkpointOid: null, diffSummary: null, tests: [], toolSummaries: [] },
        injectedReadOnlySnapshot: null,
      },
    };
    const repository = new ContextRepository(new ProviderRepository(first.db), () => "2026-07-31T00:00:00.000Z");
    expect(repository.save(bundle, first.records.run.id)).toEqual(bundle);
    expect(repository.save(bundle, first.records.run.id)).toEqual(bundle);
    first.db.close();

    const second = openTestDatabase(first.path);
    const reopened = new ContextRepository(new ProviderRepository(second.db), () => "2026-07-31T00:00:01.000Z");
    expect(reopened.getByHash(first.records.run.id, bundle.hash)).toEqual(bundle);
    second.db.close();
  });
});
