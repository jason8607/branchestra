import { describe, expect, it } from "vitest";
import { MockProvider } from "../../../src/worker/providers/mock-provider";
import type {
  TaskProviderEvent,
  TaskProviderRunRequest,
  TaskProviderResumeRequest
} from "../../../src/worker/tasks/provider-port";

const request: TaskProviderRunRequest = {
  runId: "run-1",
  taskId: "task-1",
  roomId: "room-1",
  provider: "claude",
  role: "lead",
  worktreePath: "/tmp/worktree",
  instruction: "Implement it",
  contextVersion: 3,
  contextHash: `sha256:${"a".repeat(64)}`,
  checkpointOid: null,
  approvedCapabilities: {
    workspaceRootRealpath: "/tmp/worktree",
    readableRootsRealpath: ["/tmp/repository", "/tmp/worktree"],
    commandClasses: ["test"],
    toolNetwork: false,
    allowCollaborator: false,
    maxRunMs: 10_000
  }
};

async function collect(events: AsyncIterable<TaskProviderEvent>): Promise<TaskProviderEvent[]> {
  const collected: TaskProviderEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

async function settleWithin<T>(promise: Promise<T>): Promise<T> {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => deadline.reject(new Error("MOCK_COMPLETION_DID_NOT_SETTLE")),
    250
  );
  try {
    return await Promise.race([promise, deadline.promise]);
  } finally {
    clearTimeout(timer);
  }
}

describe("MockProvider", () => {
  it("emits its script deterministically and completes", async () => {
    const mock = new MockProvider(() => ({
      sessionId: "session-1",
      steps: [
        { type: "assistant.message", text: "Starting" },
        { type: "run.completed", summary: "done" }
      ]
    }));

    const handle = await mock.startRun(request);

    await expect(collect(handle.events)).resolves.toEqual([
      { type: "assistant.message", text: "Starting" },
      { type: "run.completed", summary: "done" }
    ]);
    await expect(handle.completion).resolves.toEqual({
      outcome: "completed",
      summary: "done",
      error: null
    });
    expect(handle.sessionId).toBe("session-1");
  });

  it("blocks until cancelled, closes the queue, and treats repeated cancel as idempotent", async () => {
    const mock = new MockProvider(() => ({
      sessionId: "session-1",
      steps: [
        { type: "assistant.message", text: "partial" },
        { type: "waitForCancel" },
        { type: "assistant.message", text: "must not emit" }
      ]
    }));
    const handle = await mock.startRun(request);
    const events = collect(handle.events);

    await mock.waitUntilBlocked();
    await mock.cancelRun("run-1", "user");
    await mock.cancelRun("run-1", "quit");

    await expect(events).resolves.toEqual([
      { type: "assistant.message", text: "partial" }
    ]);
    await expect(handle.completion).resolves.toEqual({
      outcome: "cancelled",
      summary: "Cancelled: user",
      error: null
    });
  });

  it("rejects cancellation for an unknown run", async () => {
    const mock = new MockProvider(() => ({ sessionId: "session-1", steps: [] }));

    await expect(mock.cancelRun("missing", "user")).rejects.toThrow(
      "MOCK_RUN_NOT_FOUND"
    );
  });

  it("uses the persisted session id and a resume-specific script", async () => {
    const seen: Array<TaskProviderRunRequest | TaskProviderResumeRequest> = [];
    const mock = new MockProvider((runRequest) => {
      seen.push(runRequest);
      return {
        sessionId: "new-session-must-not-replace-persisted",
        steps: [{ type: "run.completed", summary: "resumed" }]
      };
    });
    const resumeRequest: TaskProviderResumeRequest = {
      ...request,
      runId: "run-resume",
      providerSessionId: "persisted-session",
      recoveryBrief: "Continue from durable state"
    };

    const handle = await mock.resumeRun(resumeRequest);
    await collect(handle.events);

    expect(seen).toEqual([resumeRequest]);
    expect(handle.sessionId).toBe("persisted-session");
    await expect(handle.completion).resolves.toMatchObject({
      outcome: "completed",
      summary: "resumed"
    });
  });

  it("settles a scripted throw as a structured failure", async () => {
    const mock = new MockProvider(() => ({
      sessionId: "session-1",
      steps: [{ type: "throw", code: "SCRIPT_FAILURE", message: "boom" }]
    }));

    const handle = await mock.startRun(request);

    await expect(handle.completion).resolves.toEqual({
      outcome: "failed",
      summary: "boom",
      error: { code: "SCRIPT_FAILURE", message: "boom" }
    });
    await expect(collect(handle.events)).resolves.toEqual([]);
  });

  it("settles completion when a for-await consumer breaks before a terminal step", async () => {
    const mock = new MockProvider(() => ({
      sessionId: "session-early-break",
      steps: [
        { type: "assistant.message", text: "first" },
        { type: "assistant.message", text: "second" },
        { type: "waitForCancel" }
      ]
    }));
    const handle = await mock.startRun(request);

    for await (const event of handle.events) {
      expect(event).toEqual({ type: "assistant.message", text: "first" });
      break;
    }

    await expect(settleWithin(handle.completion)).resolves.toEqual({
      outcome: "cancelled",
      summary: "Event consumer closed",
      error: null
    });
    await expect(mock.cancelRun("run-1", "quit")).resolves.toBeUndefined();
  });

  it("settles completion when AsyncIterator.return closes a blocked run", async () => {
    const mock = new MockProvider(() => ({
      sessionId: "session-return",
      steps: [{ type: "waitForCancel" }]
    }));
    const handle = await mock.startRun(request);
    const iterator = handle.events[Symbol.asyncIterator]();

    await iterator.return?.();

    await expect(settleWithin(handle.completion)).resolves.toEqual({
      outcome: "cancelled",
      summary: "Event consumer closed",
      error: null
    });
  });

  it("releases live resources while retaining every known terminal run identity", async () => {
    const mock = new MockProvider(() => ({
      sessionId: "session-terminal",
      steps: [{ type: "run.completed", summary: "done" }]
    }));

    for (let index = 0; index < 80; index += 1) {
      const handle = await mock.startRun({ ...request, runId: `run-${index}` });
      await collect(handle.events);
      await handle.completion;
    }

    await expect(mock.cancelRun("run-79", "user")).resolves.toBeUndefined();
    await expect(mock.cancelRun("run-0", "user")).resolves.toBeUndefined();
    await expect(mock.startRun({ ...request, runId: "run-0" })).rejects.toThrow(
      "MOCK_RUN_ALREADY_EXISTS:run-0"
    );
    await expect(mock.cancelRun("never-started", "user")).rejects.toThrow(
      "MOCK_RUN_NOT_FOUND:never-started"
    );
  });
});
