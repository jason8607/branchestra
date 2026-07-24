import { describe, expect, it } from "vitest";
import type {
  TaskProviderEvent,
  TaskProviderPort,
  TaskProviderRunResult
} from "../../../src/worker/tasks/provider-port";
import { NON_TERMINAL_TASK_STATES } from "../../../src/worker/tasks/task-state-machine";
import { createTaskEngineFixture } from "../../fixtures/task-engine";

describe("TaskEngine cancellation and process loss", () => {
  it("settles CancelRequested and preserves branch, worktree, commit, and uncommitted content", async () => {
    const fixture = await createTaskEngineFixture({
      mockScript: [
        { type: "workspace.writeText", relativePath: "partial.txt", contents: "keep me\n" },
        { type: "waitForCancel" }
      ]
    });
    try {
      const running = fixture.engine.startApprovedTask("task-1", "start-1");
      await fixture.mock.waitUntilBlocked();

      const cancelled = await fixture.engine.cancel("task-1", "user", "cancel-1");
      const settledRun = await running;

      expect(cancelled.state).toBe("Cancelled");
      expect(settledRun.state).toBe("Cancelled");
      expect(fixture.tasks.getRequired("task-1").state).toBe("Cancelled");
      await expect(fixture.readLeadFile("partial.txt")).resolves.toBe("keep me\n");
      await expect(fixture.leadBranchExists()).resolves.toBe(true);
      expect(fixture.gitMutationCalls()).not.toContain("worktree remove");
      expect(fixture.tasks.listRuns("task-1")).toEqual([
        expect.objectContaining({ state: "cancelled" })
      ]);
      expect(fixture.artifacts.listCheckpoints("task-1")).toHaveLength(0);

      await expect(fixture.engine.cancel("task-1", "user", "cancel-1"))
        .resolves.toEqual(cancelled);
      expect(fixture.providerCalls().cancelRun).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("cancels Preparing directly without creating a worktree or dispatching Provider work", async () => {
    const fixture = await createTaskEngineFixture({ mockScript: [] });
    try {
      const result = await fixture.engine.cancel("task-1", "user", "cancel-preparing");

      expect(result.state).toBe("Cancelled");
      expect(fixture.providerCalls()).toEqual({
        startRun: 0,
        resumeRun: 0,
        cancelRun: 0
      });
      expect(fixture.artifacts.listWorktrees("task-1")).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("cancels after a checkpoint while retaining its immutable commit and ref", async () => {
    const fixture = await createTaskEngineFixture({
      mockScript: [
        { type: "workspace.writeText", relativePath: "done.txt", contents: "done\n" },
        { type: "run.completed", summary: "checkpointed" }
      ]
    });
    try {
      const checkpointed = await fixture.engine.startApprovedTask("task-1", "start-checkpoint");
      const checkpointsBefore = fixture.artifacts.listCheckpoints("task-1");

      const cancelled = await fixture.engine.cancel("task-1", "user", "cancel-checkpoint");

      expect(checkpointed.state).toBe("Checkpoint");
      expect(cancelled.state).toBe("Cancelled");
      expect(fixture.artifacts.listCheckpoints("task-1")).toEqual(checkpointsBefore);
      await expect(fixture.leadBranchExists()).resolves.toBe(true);
      await expect(fixture.readLeadFile("done.txt")).resolves.toBe("done\n");
      expect(fixture.gitMutationCalls()).not.toContain("worktree remove");
    } finally {
      await fixture.cleanup();
    }
  });

  it("retires timed-out handles and ignores a late Provider completion", async () => {
    const completion = Promise.withResolvers<TaskProviderRunResult>();
    const nextEvent = Promise.withResolvers<IteratorResult<TaskProviderEvent>>();
    const consuming = Promise.withResolvers<void>();
    const provider: TaskProviderPort = {
      async startRun(request) {
        return {
          runId: request.runId,
          sessionId: "late-session",
          events: {
            [Symbol.asyncIterator]() {
              return {
                next() {
                  consuming.resolve();
                  return nextEvent.promise;
                },
                async return() {
                  return { value: undefined, done: true };
                }
              };
            }
          },
          completion: completion.promise
        };
      },
      async resumeRun() {
        throw new Error("UNEXPECTED_RESUME");
      },
      async cancelRun() {
        // Intentionally acknowledges cancellation without settling completion.
      }
    };
    const fixture = await createTaskEngineFixture({
      mockScript: [],
      maxRunMs: 20,
      providerOverride: provider
    });
    let running: Promise<unknown> | undefined;
    try {
      running = fixture.engine.startApprovedTask("task-1", "timeout-start");
      await consuming.promise;
      expect(fixture.inMemoryRunCounts()).toEqual({ active: 1, pending: 0 });

      const timedOut = await fixture.engine.cancel(
        "task-1",
        "timeout",
        "timeout-cancel"
      );

      expect(timedOut).toMatchObject({
        state: "Failed",
        failure: { code: "CANCEL_GRACE_TIMEOUT" }
      });
      expect(fixture.inMemoryRunCounts()).toEqual({ active: 0, pending: 0 });
      expect(fixture.tasks.listRuns("task-1")).toEqual([
        expect.objectContaining({ state: "failed" })
      ]);

      nextEvent.resolve({
        value: { type: "run.completed", summary: "too late" },
        done: false
      });
      completion.resolve({
        outcome: "completed",
        summary: "too late",
        error: null
      });

      await expect(running).resolves.toEqual(timedOut);
      expect(fixture.tasks.getRequired("task-1")).toEqual(timedOut);
      expect(fixture.tasks.listRuns("task-1")).toEqual([
        expect.objectContaining({ state: "failed" })
      ]);
      expect(fixture.artifacts.listCheckpoints("task-1")).toHaveLength(0);
      expect(fixture.inMemoryRunCounts()).toEqual({ active: 0, pending: 0 });
    } finally {
      completion.resolve({
        outcome: "cancelled",
        summary: "cleanup",
        error: null
      });
      nextEvent.resolve({ value: undefined, done: true });
      await running?.catch(() => undefined);
      await fixture.cleanup();
    }
  });

  it.each(NON_TERMINAL_TASK_STATES)(
    "moves %s to Interrupted with the exact prior phase and collaboration count without Provider calls",
    async (state) => {
      const fixture = await createTaskEngineFixture({ mockScript: [], initialState: state });
      try {
        const current = fixture.tasks.getRequired("task-1");
        fixture.tasks.updateState({
          ...current,
          collaborationRoundsUsed: 1,
          version: current.version + 1
        }, current.version);
        const gitBefore = await fixture.captureGitState();

        const interrupted = await fixture.engine.handleProcessLoss(
          "task-1",
          "lost-generation",
          `loss-${state}`
        );

        expect(interrupted.state).toBe("Interrupted");
        expect(interrupted.collaborationRoundsUsed).toBe(1);
        if (state !== "Interrupted") expect(interrupted.interruptedFromState).toBe(state);
        expect(fixture.events.byType("task.interrupted").at(-1)?.payload).toEqual({
          taskId: "task-1",
          from: state,
          workerGeneration: "lost-generation"
        });
        expect(fixture.providerCalls()).toEqual({
          startRun: 0,
          resumeRun: 0,
          cancelRun: 0
        });
        await expect(fixture.captureGitState()).resolves.toEqual(gitBefore);
      } finally {
        await fixture.cleanup();
      }
    }
  );

  it("interrupts an active run, preserves dirty worktree state, and never cancels, starts, or resumes during loss handling", async () => {
    const fixture = await createTaskEngineFixture({
      mockScript: [
        { type: "workspace.writeText", relativePath: "partial.txt", contents: "keep\n" },
        { type: "waitForCancel" }
      ]
    });
    try {
      const running = fixture.engine.startApprovedTask("task-1", "active-loss-start");
      await fixture.mock.waitUntilBlocked();
      const gitBefore = await fixture.captureGitState();
      const callsBefore = fixture.providerCalls();

      const interrupted = await fixture.engine.handleProcessLoss(
        "task-1",
        "lost-generation",
        "active-loss"
      );

      expect(interrupted).toMatchObject({
        state: "Interrupted",
        interruptedFromState: "Working"
      });
      expect(fixture.tasks.listRuns("task-1")).toEqual([
        expect.objectContaining({ state: "interrupted" })
      ]);
      expect(fixture.providerCalls()).toEqual(callsBefore);
      await expect(fixture.captureGitState()).resolves.toEqual(gitBefore);
      await expect(fixture.readLeadFile("partial.txt")).resolves.toBe("keep\n");
      expect(fixture.journal.getByIdempotencyKey("active-loss:git-status"))
        .toMatchObject({
          operationType: "process_loss.git_status",
          status: "completed",
          observation: {
            outcome: "applied",
            actual: {
              entries: expect.arrayContaining(["? partial.txt"])
            }
          }
        });

      await fixture.mock.cancelRun(
        fixture.tasks.listRuns("task-1")[0]!.id,
        "quit"
      );
      await expect(running).resolves.toMatchObject({ state: "Interrupted" });
    } finally {
      await fixture.cleanup();
    }
  });
});
