import { describe, expect, it } from "vitest";
import { ContextBuilder } from "../../../src/worker/context/context-builder";

const message = (eventId: string, roomSeq: number, author: "user" | "claude" | "codex", body: string) => ({ eventId, roomSeq, author, body });

describe("ContextBuilder", () => {
  it("combines current, memory, relevant history, and peer artifacts", async () => {
    const source = {
      nextVersion: async () => 4,
      recentMessages: async () => [message("e-9", 9, "user", "Keep the protocol narrow")],
      roomMemory: async () => ({ summaryVersion: 3, summary: "Build adapters", decisions: ["No API fallback"] }),
      relevantMessages: async () => [message("e-2", 2, "claude", "Use raw-event-first persistence")],
      peerArtifacts: async () => ({ messages: [message("e-8", 8, "codex", "The fixture passes")], checkpointOid: "a".repeat(40), diffSummary: "2 files changed", tests: ["pnpm test:unit: pass"], toolSummaries: ["git.status: clean"] }),
    };
    const builder = new ContextBuilder(source);
    const input = { runId: "019f842d-e19a-7cc1-9d73-4d287bf40558", roomId: "room-1", taskId: "task-1", role: "lead" as const, instruction: "Implement provider adapters", approvedScope: "write only the lead worktree", lead: "claude" as const };
    const first = await builder.build(input);
    const second = await builder.build(input);
    expect(first.payload.recentVerbatim[0]!.body).toBe("Keep the protocol narrow");
    expect(first.payload.roomMemory.decisions).toEqual(["No API fallback"]);
    expect(first.payload.relevantHistory[0]!.eventId).toBe("e-2");
    expect(first.payload.peer.checkpointOid).toBe("a".repeat(40));
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.hash).toBe(first.hash);
  });

  it("changes the hash when a confirmed decision changes", async () => {
    let decision = "Network off";
    const source = {
      nextVersion: async () => 1,
      recentMessages: async () => [],
      roomMemory: async () => ({ summaryVersion: 1, summary: "Adapter", decisions: [decision] }),
      relevantMessages: async () => [],
      peerArtifacts: async () => ({ messages: [], checkpointOid: null, diffSummary: null, tests: [], toolSummaries: [] }),
    };
    const builder = new ContextBuilder(source);
    const input = { runId: "019f842d-e19a-7cc1-9d73-4d287bf40558", roomId: "r", taskId: "t", role: "collaborator" as const, instruction: "Review", approvedScope: "read", lead: "codex" as const };
    const before = await builder.build(input);
    decision = "Network on";
    const after = await builder.build(input);
    expect(after.hash).not.toBe(before.hash);
  });
});
