import { createHash } from "node:crypto";
import type { ContextBundle, ContextBundlePayload, ContextMessage, ProviderId } from "../../shared/contracts/provider";
import { stableJson } from "./stable-json";

export interface ContextSource {
  nextVersion(runId: string): Promise<number>;
  recentMessages(roomId: string, limit: 40): Promise<readonly ContextMessage[]>;
  roomMemory(roomId: string): Promise<ContextBundlePayload["roomMemory"]>;
  relevantMessages(input: { roomId: string; taskId: string; queryTerms: readonly string[]; excludeEventIds: readonly string[]; limit: 20 }): Promise<readonly ContextMessage[]>;
  peerArtifacts(input: { taskId: string; role: "lead" | "collaborator"; messageLimit: 12 }): Promise<ContextBundlePayload["peer"]>;
}

export interface BuildContextInput {
  runId: string;
  roomId: string;
  taskId: string;
  role: "lead" | "collaborator";
  instruction: string;
  approvedScope: string;
  lead: ProviderId;
  injectedReadOnlySnapshot?: string | null;
}

export class ContextBuilder {
  constructor(private readonly source: ContextSource) {}

  async build(input: BuildContextInput): Promise<ContextBundle> {
    const recentVerbatim = [...await this.source.recentMessages(input.roomId, 40)].sort((a, b) => a.roomSeq - b.roomSeq);
    const queryTerms = [...new Set((input.instruction.toLowerCase().match(/[a-z0-9_/-]{3,}/g) ?? []).slice(0, 12))];
    const [version, roomMemory, relevantHistory, peer] = await Promise.all([
      this.source.nextVersion(input.runId),
      this.source.roomMemory(input.roomId),
      this.source.relevantMessages({ roomId: input.roomId, taskId: input.taskId, queryTerms, excludeEventIds: recentVerbatim.map((item) => item.eventId), limit: 20 }),
      this.source.peerArtifacts({ taskId: input.taskId, role: input.role, messageLimit: 12 }),
    ]);
    const payload: ContextBundlePayload = {
      task: { instruction: input.instruction, approvedScope: input.approvedScope, lead: input.lead },
      recentVerbatim,
      roomMemory,
      relevantHistory: [...relevantHistory].sort((a, b) => a.roomSeq - b.roomSeq),
      peer,
      injectedReadOnlySnapshot: input.injectedReadOnlySnapshot ?? null,
    };
    const hash = createHash("sha256").update(stableJson({ roomId: input.roomId, taskId: input.taskId, role: input.role, payload })).digest("hex");
    return { version, hash, roomId: input.roomId, taskId: input.taskId, role: input.role, payload };
  }
}
