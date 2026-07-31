import { describe, expect, it, vi } from "vitest";
import { ReadOnlyToolService } from "../../../src/worker/tools/read-only-tool-service";

const binding = {
  roomId: "room-1", taskId: "task-1", repositoryRootRealpath: "/repo",
  worktreePathRealpath: "/worktrees/task-1/lead", startOid: "1".repeat(40),
  checkpointOids: new Set(["1".repeat(40), "2".repeat(40)]),
};

describe("ReadOnlyToolService", () => {
  it("binds git.status to the run worktree instead of caller paths", async () => {
    const git = { status: vi.fn().mockResolvedValue({ clean: true, entries: [] }) };
    const service = new ReadOnlyToolService({ git: git as never, context: {} as never });
    await expect(service.execute(binding, { name: "git.status", input: {} })).resolves.toEqual({ content: JSON.stringify({ clean: true, entries: [] }), truncated: false });
    expect(git.status).toHaveBeenCalledWith({ repositoryRootRealpath: "/repo", worktreePathRealpath: "/worktrees/task-1/lead" });
  });

  it("rejects arbitrary revisions and every unregistered mutation name", async () => {
    const service = new ReadOnlyToolService({ git: {} as never, context: {} as never });
    await expect(service.execute(binding, { name: "git.show", input: { checkpointOid: "f".repeat(40) } })).rejects.toThrow("Checkpoint is not owned by task task-1");
    await expect(service.execute(binding, { name: "git.commit", input: {} } as never)).rejects.toThrow("Unknown read-only tool: git.commit");
  });

  it("scopes context reads to the bound room", async () => {
    const context = { read: vi.fn().mockResolvedValue([{ eventId: "e-1", roomId: "room-1", body: "decision" }]) };
    const service = new ReadOnlyToolService({ git: {} as never, context: context as never });
    await service.execute(binding, { name: "context.read", input: { eventIds: ["e-1"] } });
    expect(context.read).toHaveBeenCalledWith({ roomId: "room-1", eventIds: ["e-1"], limit: 50 });
  });
});
