import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { openTestDatabase } from "../../fixtures/test-database";
import { transitionTask } from "../../../src/worker/tasks/task-state-machine";
import { createEventStore } from "../../../src/worker/storage/event-store";
import { createRepositories } from "../../../src/worker/storage/repositories";

describe("TaskRepository", () => {
  const fixtures: ReturnType<typeof openTestDatabase>[] = [];

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) {
      fixture.db.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  function setup(): ReturnType<typeof openTestDatabase> & {
    repositories: ReturnType<typeof createRepositories>;
    events: ReturnType<typeof createEventStore>;
  } {
    const fixture = openTestDatabase();
    fixtures.push(fixture);
    const repositories = createRepositories(fixture.db);
    const events = createEventStore(fixture.db, repositories);
    return { ...fixture, repositories, events };
  }

  it("maps every task column and lists only non-terminal tasks", () => {
    const current = setup();
    current.repositories.tasks.insert(current.records.task);
    const completed = {
      ...current.records.task,
      id: "task-completed",
      requestEventId: "30000000-0000-4000-8000-000000000002",
      state: "Completed" as const,
      failure: { code: "RECOVERED", message: "Stored explicitly" },
      revisionKind: "human_directed" as const,
      interruptedFromState: "Working" as const,
      scopeApprovalId: "approval-reference",
      activeCandidateId: "candidate-reference",
      collaborationRoundsUsed: 3,
      collaborationRoundBudget: 4,
      humanRevisionCount: 2,
      version: 9
    };
    current.repositories.tasks.insert(completed);
    expect(current.repositories.tasks.getRequired(completed.id)).toEqual(completed);
    expect(current.repositories.tasks.get("missing")).toBeNull();
    expect(current.repositories.tasks.listNonTerminal()).toEqual([current.records.task]);
    expect(() => current.repositories.tasks.getRequired("missing")).toThrow("TASK_NOT_FOUND:missing");
  });

  it("updates a task and appends its canonical event in one transaction", () => {
    const current = setup();
    current.repositories.tasks.insert(current.records.task);
    const transition = transitionTask(current.records.task, {
      type: "approveScope",
      receiptId: current.records.scopeApproval.id,
      collaborationRoundBudget: 2
    });
    const result = current.repositories.tasks.applyTransition(
      transition,
      "40000000-0000-4000-8000-000000000001"
    );
    expect(result).toEqual(transition.next);
    expect(current.repositories.tasks.getRequired(current.records.task.id)).toEqual(transition.next);
    expect(current.events.after({ roomId: current.records.room.id, roomSeq: 0, limit: 10 }).events)
      .toEqual([{
        id: "40000000-0000-4000-8000-000000000001",
        roomId: current.records.room.id,
        roomSeq: 1,
        type: "task.transitioned",
        actor: "system",
        payload: transition.event.payload,
        createdAt: transition.next.updatedAt
      }]);
  });

  it("rolls back a task update when canonical event append fails", () => {
    const current = setup();
    current.repositories.tasks.insert(current.records.task);
    current.events.append({
      id: "40000000-0000-4000-8000-000000000002",
      roomId: current.records.room.id,
      type: "message.posted",
      actor: "user",
      payload: {
        id: "50000000-0000-4000-8000-000000000001",
        roomId: current.records.room.id,
        body: "reserve event id",
        createdAt: current.records.task.createdAt
      },
      createdAt: current.records.task.createdAt
    });
    const transition = transitionTask(current.records.task, {
      type: "approveScope",
      receiptId: current.records.scopeApproval.id,
      collaborationRoundBudget: 2
    });
    expect(() => current.repositories.tasks.applyTransition(
      transition,
      "40000000-0000-4000-8000-000000000002"
    )).toThrow(/UNIQUE constraint/);
    expect(current.repositories.tasks.getRequired(current.records.task.id)).toEqual(current.records.task);
  });

  it("persists, orders, and updates agent runs", () => {
    const current = setup();
    current.repositories.tasks.insert(current.records.task);
    const later = {
      ...current.records.run,
      id: "run-2",
      provider: "codex" as const,
      role: "reviewer" as const,
      startedAt: "2026-07-22T10:04:00.000Z"
    };
    current.repositories.tasks.insertRun(later);
    current.repositories.tasks.insertRun(current.records.run);
    current.repositories.tasks.updateRunState(
      current.records.run.id,
      "completed",
      "2026-07-22T10:05:00.000Z"
    );
    expect(current.repositories.tasks.getRun(current.records.run.id)).toEqual({
      ...current.records.run,
      state: "completed",
      finishedAt: "2026-07-22T10:05:00.000Z"
    });
    expect(current.repositories.tasks.listRuns(current.records.task.id).map((run) => run.id))
      .toEqual([current.records.run.id, later.id]);
    expect(current.repositories.tasks.getRun("missing")).toBeNull();
  });

  it("invalidates only restart-sensitive approvals from older generations", () => {
    const current = setup();
    current.repositories.tasks.insert(current.records.task);
    current.repositories.approvals.insertRequest(current.records.scopeApprovalRequest);
    current.repositories.approvals.decideRequest(
      current.records.scopeApprovalRequest.id,
      current.records.scopeApproval
    );
    current.repositories.approvals.insertRequest(current.records.sensitiveApprovalRequest);
    current.repositories.approvals.decideRequest(
      current.records.sensitiveApprovalRequest.id,
      current.records.sensitiveApproval
    );
    expect(current.repositories.approvals.invalidateSensitiveFromOlderGeneration("generation-2"))
      .toEqual([current.records.sensitiveApproval.id]);
    expect(current.repositories.approvals.get(current.records.sensitiveApproval.id)).toBeNull();
    expect(current.repositories.approvals.findApproved(
      current.records.task.id,
      "task_scope",
      current.records.scopeApproval.scopeHash
    )).toEqual(current.records.scopeApproval);
    expect(current.repositories.approvals.listForTask(current.records.task.id))
      .toEqual([current.records.scopeApproval]);
  });
});
