import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTaskEngineFixture } from "../../fixtures/task-engine";

describe("TaskEngine run", () => {
  it("runs an approved lead revision through the provider and checkpoints it", async () => {
    const fixture = await createTaskEngineFixture({
      initialState: "Revision",
      mockScript: [
        { type: "workspace.writeText", relativePath: "revision.txt", contents: "revised\n" },
        { type: "run.completed", summary: "review addressed" }
      ]
    });
    try {
      const lead = await fixture.prepareLead("prepare-revision-lead");
      await fixture.repository.writeAt(lead.pathRealpath, "initial.txt", "initial\n");
      await fixture.manager.createCheckpoint({
        projectId: fixture.project.id,
        taskId: "task-1",
        worktree: lead,
        authorProvider: "claude",
        purpose: "implementation",
        message: "Initial implementation",
        checkpointId: "initial-checkpoint",
        workerGeneration: fixture.generation,
        idempotencyKey: "initial-checkpoint"
      });

      const result = await fixture.engine.runLeadRevision({
        taskId: "task-1",
        findings: ["address the review"],
        idempotencyKey: "revision-run"
      });

      expect(result.state).toBe("Revision");
      await expect(fixture.readLeadFile("revision.txt")).resolves.toBe("revised\n");
      expect(fixture.artifacts.listCheckpoints("task-1").at(-1)).toMatchObject({
        authorProvider: "claude",
        purpose: "revision"
      });
      expect(fixture.providerRequests().at(-1)).toMatchObject({
        provider: "claude",
        role: "lead",
        checkpointOid: expect.any(String)
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("prepares an approved Lead worktree, durably records events before publish, writes through the approved workspace, and checkpoints", async () => {
    const fixture = await createTaskEngineFixture({
      mockScript: [
        { type: "assistant.message", text: "Starting" },
        { type: "workspace.writeText", relativePath: "feature.txt", contents: "done\n" },
        { type: "run.completed", summary: "implemented" }
      ]
    });
    try {
      const result = await fixture.engine.startApprovedTask("task-1", "start-1");

      expect(result).toMatchObject({ state: "Checkpoint", failure: null });
      await expect(fixture.readLeadFile("feature.txt")).resolves.toBe("done\n");
      expect(fixture.events.types()).toEqual(expect.arrayContaining([
        "agent.run",
        "checkpoint.created",
        "task.transitioned"
      ]));
      expect(fixture.events.persistedBeforePublish()).toBe(true);
      expect(fixture.tasks.listRuns("task-1")).toEqual([
        expect.objectContaining({
          taskId: "task-1",
          state: "completed",
          providerSessionId: "mock-session-1"
        })
      ]);
      expect(fixture.artifacts.listCheckpoints("task-1")).toHaveLength(1);
      expect(fixture.providerCalls()).toMatchObject({ startRun: 1, resumeRun: 0 });
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails closed on parent traversal while durably recording the denied request", async () => {
    const fixture = await createTaskEngineFixture({
      mockScript: [
        { type: "workspace.writeText", relativePath: "../escape.txt", contents: "no\n" },
        { type: "run.completed", summary: "must not complete" }
      ]
    });
    try {
      const result = await fixture.engine.startApprovedTask("task-1", "traversal");

      expect(result).toMatchObject({
        state: "Failed",
        failure: { code: "PATH_INVALID" }
      });
      await expect(fixture.leadPathExists("../escape.txt")).resolves.toBe(false);
      expect(fixture.events.byType("agent.run").at(-1)?.payload.event).toMatchObject({
        type: "workspace.writeText",
        relativePath: "../escape.txt"
      });
      expect(fixture.artifacts.listCheckpoints("task-1")).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a symlink escape introduced after approval without writing outside", async () => {
    const outside = await mkdtemp(join(tmpdir(), "branchestra-engine-outside-"));
    const fixture = await createTaskEngineFixture({
      mockScript: [
        {
          type: "workspace.writeText",
          relativePath: "escape-link/pwn.txt",
          contents: "no\n"
        }
      ]
    });
    try {
      await fixture.prepareLead("prepare-symlink");
      await fixture.createLeadSymlink("escape-link", outside);

      const result = await fixture.engine.startApprovedTask("task-1", "symlink-escape");

      expect(result.state).toBe("Failed");
      await expect(fixture.absolutePathExists(join(outside, "pwn.txt"))).resolves.toBe(false);
      expect(fixture.artifacts.listCheckpoints("task-1")).toHaveLength(0);
    } finally {
      await fixture.cleanup();
      await rm(outside, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "test command",
      options: {
        commandClasses: ["build"] as Array<"build" | "test" | "lint" | "format">,
        mockScript: [{ type: "test.request" as const, commandId: "unit" }]
      },
      code: "TEST_COMMAND_NOT_APPROVED"
    },
    {
      name: "collaborator",
      options: {
        allowCollaborator: false,
        mockScript: [{
          type: "collaborator.request" as const,
          purpose: "review" as const
        }]
      },
      code: "COLLABORATOR_NOT_APPROVED"
    }
  ])("denies an unapproved $name request before dispatch", async ({ options, code }) => {
    const fixture = await createTaskEngineFixture(options);
    try {
      const result = await fixture.engine.startApprovedTask("task-1", `deny-${code}`);

      expect(result).toMatchObject({ state: "Failed", failure: { code } });
      expect(fixture.events.byType("agent.run")).toHaveLength(1);
      expect(fixture.artifacts.listCheckpoints("task-1")).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("persists a provider failure and never checkpoints it", async () => {
    const fixture = await createTaskEngineFixture({
      mockScript: [{ type: "run.failed", code: "MOCK_FAILURE", message: "failed" }]
    });
    try {
      const result = await fixture.engine.startApprovedTask("task-1", "provider-failure");

      expect(result).toMatchObject({
        state: "Failed",
        failure: { code: "MOCK_FAILURE", message: "failed" }
      });
      expect(fixture.tasks.listRuns("task-1")).toEqual([
        expect.objectContaining({ state: "failed" })
      ]);
      expect(fixture.artifacts.listCheckpoints("task-1")).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("replays a duplicate completed start key without dispatching another run", async () => {
    const fixture = await createTaskEngineFixture({
      mockScript: [{ type: "run.completed", summary: "once" }]
    });
    try {
      const first = await fixture.engine.startApprovedTask("task-1", "same-start");
      const replay = await fixture.engine.startApprovedTask("task-1", "same-start");

      expect(replay).toEqual(first);
      expect(fixture.providerCalls()).toMatchObject({ startRun: 1, resumeRun: 0 });
      expect(fixture.tasks.listRuns("task-1")).toHaveLength(1);
      expect(fixture.artifacts.listCheckpoints("task-1")).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("joins a concurrent distinct-key start and durably completes both commands", async () => {
    const fixture = await createTaskEngineFixture({
      mockScript: [{ type: "run.completed", summary: "shared" }]
    });
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    try {
      first = fixture.engine.startApprovedTask("task-1", "concurrent-first");
      second = fixture.engine.startApprovedTask("task-1", "concurrent-second");

      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(secondResult).toEqual(firstResult);
      expect(firstResult).toMatchObject({ state: "Checkpoint" });
      expect(fixture.providerCalls().startRun).toBe(1);
      expect(fixture.tasks.listRuns("task-1")).toHaveLength(1);
      await expect(
        fixture.engine.startApprovedTask("task-1", "concurrent-second")
      ).resolves.toEqual(secondResult);
    } finally {
      await first?.catch(() => undefined);
      await second?.catch(() => undefined);
      await fixture.cleanup();
    }
  });

  it("rejects a new start after checkpoint without mutating the durable task", async () => {
    const fixture = await createTaskEngineFixture({
      mockScript: [{ type: "run.completed", summary: "once" }]
    });
    try {
      const checkpointed = await fixture.engine.startApprovedTask("task-1", "first-start");

      await expect(fixture.engine.startApprovedTask("task-1", "different-start"))
        .rejects.toThrow("TASK_NOT_PREPARING:Checkpoint");
      expect(fixture.tasks.getRequired("task-1")).toEqual(checkpointed);
      expect(fixture.providerCalls().startRun).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });
});
