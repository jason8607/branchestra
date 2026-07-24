import { describe, expect, it } from "vitest";
import type {
  TaskProviderEvent,
  TaskProviderPort,
  TaskProviderRunHandle,
  TaskProviderRunResult
} from "../../../src/worker/tasks/provider-port";
import { NON_TERMINAL_TASK_STATES } from "../../../src/worker/tasks/task-state-machine";
import { createTaskEngineFixture } from "../../fixtures/task-engine";

async function settleWithin<T>(promise: Promise<T>, failure: string): Promise<T> {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => deadline.reject(new Error(failure)), 1_000);
  try {
    return await Promise.race([promise, deadline.promise]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitUntil(predicate: () => boolean, failure: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(failure);
}

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
    let iteratorReturns = 0;
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
                  iteratorReturns += 1;
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

      await expect(settleWithin(
        running,
        "ACTIVE_TIMEOUT_START_DID_NOT_SETTLE"
      )).resolves.toEqual(timedOut);
      expect(iteratorReturns).toBe(1);

      nextEvent.resolve({
        value: { type: "run.completed", summary: "too late" },
        done: false
      });
      completion.resolve({
        outcome: "completed",
        summary: "too late",
        error: null
      });

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

  it("cancels a pending start immediately and retires its late handle", async () => {
    const started = Promise.withResolvers<TaskProviderRunHandle>();
    const cancelCalled = Promise.withResolvers<string>();
    const completion = Promise.withResolvers<TaskProviderRunResult>();
    let iteratorReturns = 0;
    let iteratorNexts = 0;
    const lateHandle = (runId: string): TaskProviderRunHandle => ({
      runId,
      sessionId: "late-pending-session",
      events: {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              iteratorNexts += 1;
              return { value: undefined, done: true };
            },
            async return() {
              iteratorReturns += 1;
              completion.resolve({
                outcome: "cancelled",
                summary: "late handle retired",
                error: null
              });
              return { value: undefined, done: true };
            }
          };
        }
      },
      completion: completion.promise
    });
    const provider: TaskProviderPort = {
      startRun() {
        return started.promise;
      },
      async resumeRun() {
        throw new Error("UNEXPECTED_RESUME");
      },
      async cancelRun(runId) {
        cancelCalled.resolve(runId);
      }
    };
    const fixture = await createTaskEngineFixture({
      mockScript: [],
      maxRunMs: 20,
      providerOverride: provider
    });
    let running: Promise<unknown> | undefined;
    try {
      running = fixture.engine.startApprovedTask("task-1", "pending-start");
      while (fixture.inMemoryRunCounts().pending === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      const cancelling = fixture.engine.cancel(
        "task-1",
        "timeout",
        "pending-cancel"
      );
      const cancelledRunId = await Promise.race([
        cancelCalled.promise,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("PENDING_CANCEL_NOT_DISPATCHED")), 100);
        })
      ]);

      expect(cancelledRunId).toBe(fixture.tasks.listRuns("task-1")[0]?.id);
      const timedOut = await cancelling;
      expect(timedOut).toMatchObject({
        state: "Failed",
        failure: { code: "CANCEL_GRACE_TIMEOUT" }
      });
      expect(fixture.inMemoryRunCounts()).toEqual({ active: 0, pending: 0 });
      await expect(settleWithin(
        running,
        "PENDING_TIMEOUT_START_DID_NOT_SETTLE"
      )).resolves.toEqual(timedOut);
      expect(iteratorReturns).toBe(0);
      expect(iteratorNexts).toBe(0);

      started.resolve(lateHandle(cancelledRunId));

      await waitUntil(
        () => iteratorReturns === 1,
        "LATE_PENDING_HANDLE_NOT_RETIRED"
      );
      expect(iteratorReturns).toBe(1);
      expect(iteratorNexts).toBe(0);
      expect(fixture.tasks.getRequired("task-1")).toEqual(timedOut);
      expect(fixture.tasks.listRuns("task-1")).toEqual([
        expect.objectContaining({ state: "failed" })
      ]);
      expect(fixture.artifacts.listCheckpoints("task-1")).toHaveLength(0);
      expect(fixture.events.byType("agent.run")).toHaveLength(0);
      expect(fixture.inMemoryRunCounts()).toEqual({ active: 0, pending: 0 });
    } finally {
      const runId = fixture.tasks.listRuns("task-1")[0]?.id ?? "late-cleanup";
      started.resolve(lateHandle(runId));
      completion.resolve({
        outcome: "cancelled",
        summary: "cleanup",
        error: null
      });
      await running?.catch(() => undefined);
      await fixture.cleanup();
    }
  });

  it("persists terminal failure when Provider cancellation rejects", async () => {
    const completion = Promise.withResolvers<TaskProviderRunResult>();
    const nextEvent = Promise.withResolvers<IteratorResult<TaskProviderEvent>>();
    const consuming = Promise.withResolvers<void>();
    let iteratorReturns = 0;
    const provider: TaskProviderPort = {
      async startRun(request) {
        return {
          runId: request.runId,
          sessionId: "reject-session",
          events: {
            [Symbol.asyncIterator]() {
              return {
                next() {
                  consuming.resolve();
                  return nextEvent.promise;
                },
                async return() {
                  iteratorReturns += 1;
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
        throw new Error("CANCEL_REJECTED: adapter unavailable");
      }
    };
    const fixture = await createTaskEngineFixture({
      mockScript: [],
      providerOverride: provider
    });
    let running: Promise<unknown> | undefined;
    try {
      running = fixture.engine.startApprovedTask("task-1", "reject-start");
      await consuming.promise;

      const failed = await fixture.engine.cancel(
        "task-1",
        "user",
        "reject-cancel"
      );

      expect(failed).toMatchObject({
        state: "Failed",
        failure: {
          code: "CANCEL_REJECTED",
          message: "CANCEL_REJECTED: adapter unavailable"
        }
      });
      expect(fixture.tasks.listRuns("task-1")).toEqual([
        expect.objectContaining({ state: "failed" })
      ]);
      expect(fixture.inMemoryRunCounts()).toEqual({ active: 0, pending: 0 });
      await expect(fixture.engine.cancel("task-1", "user", "reject-cancel"))
        .resolves.toEqual(failed);
      expect(fixture.providerCalls().cancelRun).toBe(1);
      await expect(settleWithin(
        running,
        "CANCEL_REJECTION_START_DID_NOT_SETTLE"
      )).resolves.toEqual(failed);
      expect(iteratorReturns).toBe(1);

      nextEvent.resolve({ value: undefined, done: true });
      completion.resolve({
        outcome: "cancelled",
        summary: "settled after rejection",
        error: null
      });
      expect(fixture.tasks.getRequired("task-1")).toEqual(failed);
      expect(fixture.artifacts.listCheckpoints("task-1")).toHaveLength(0);
    } finally {
      nextEvent.resolve({ value: undefined, done: true });
      completion.resolve({
        outcome: "cancelled",
        summary: "cleanup",
        error: null
      });
      await running?.catch(() => undefined);
      await fixture.cleanup();
    }
  });

  it("does not write when cancellation terminalizes during delayed event publish", async () => {
    const publishEntered = Promise.withResolvers<void>();
    const releasePublish = Promise.withResolvers<void>();
    const fixture = await createTaskEngineFixture({
      mockScript: [
        {
          type: "workspace.writeText",
          relativePath: "must-not-write.txt",
          contents: "too late\n"
        },
        { type: "waitForCancel" }
      ],
      maxRunMs: 20,
      publishOverride(event) {
        if (event.type === "agent.run"
          && event.payload.event.type === "workspace.writeText") {
          publishEntered.resolve();
          return releasePublish.promise;
        }
      }
    });
    let running: Promise<unknown> | undefined;
    try {
      running = fixture.engine.startApprovedTask("task-1", "delayed-publish-start");
      await publishEntered.promise;

      const failed = await fixture.engine.cancel(
        "task-1",
        "timeout",
        "delayed-publish-cancel"
      );

      expect(failed).toMatchObject({
        state: "Failed",
        failure: { code: "CANCEL_GRACE_TIMEOUT" }
      });
      await expect(fixture.leadPathExists("must-not-write.txt")).resolves.toBe(false);

      releasePublish.resolve();
      await expect(running).resolves.toEqual(failed);
      await expect(fixture.leadPathExists("must-not-write.txt")).resolves.toBe(false);
      expect(fixture.artifacts.listCheckpoints("task-1")).toHaveLength(0);
    } finally {
      releasePublish.resolve();
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
