import type { ContextBundlePayload, ContextMessage } from "../../shared/contracts/provider";
import type { GitArtifactRepository } from "../git/git-artifact-repository";
import type { Database } from "../storage/database";
import type { ContextSource } from "./context-builder";

interface EventRow {
  id: string;
  room_seq: number;
  actor: string;
  event_type: string;
  payload_json: string;
}

function asMessage(row: EventRow): (ContextMessage & { runRole: string | null }) | null {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (row.event_type === "message.posted" && typeof record.body === "string") {
    return { eventId: row.id, roomSeq: row.room_seq, author: "user", body: record.body, runRole: null };
  }
  if (row.event_type !== "agent.run") return null;
  const event = record.event;
  const run = record.run;
  if (!event || typeof event !== "object" || (event as Record<string, unknown>).type !== "assistant.message") return null;
  const text = (event as Record<string, unknown>).text;
  if (typeof text !== "string" || (row.actor !== "claude" && row.actor !== "codex")) return null;
  const runRole = run && typeof run === "object" && typeof (run as Record<string, unknown>).role === "string"
    ? String((run as Record<string, unknown>).role)
    : null;
  return { eventId: row.id, roomSeq: row.room_seq, author: row.actor, body: text, runRole };
}

function toContextMessage(message: ContextMessage & { runRole: string | null }): ContextMessage {
  return {
    eventId: message.eventId,
    roomSeq: message.roomSeq,
    author: message.author,
    body: message.body
  };
}

export class RuntimeContextSource implements ContextSource {
  constructor(
    private readonly database: Database,
    private readonly artifacts: Pick<GitArtifactRepository, "listCheckpoints" | "getWorktree">
  ) {}

  async nextVersion(runId: string): Promise<number> {
    const row = this.database.prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM context_bundles WHERE run_id = ?"
    ).get(runId) as { version: number };
    return Number(row.version) + 1;
  }

  async recentMessages(roomId: string, limit: 40): Promise<readonly ContextMessage[]> {
    return this.messageRows(roomId, 500)
      .map(asMessage)
      .filter((message): message is NonNullable<typeof message> => message !== null)
      .slice(-limit)
      .map(toContextMessage);
  }

  async roomMemory(roomId: string): Promise<ContextBundlePayload["roomMemory"]> {
    const row = this.database.prepare(
      "SELECT COALESCE(MAX(room_seq), 0) AS roomSeq, COUNT(*) AS count FROM room_events WHERE room_id = ?"
    ).get(roomId) as { roomSeq: number; count: number };
    return {
      summaryVersion: Number(row.roomSeq),
      summary: Number(row.count) === 0 ? "No prior room events." : `${Number(row.count)} durable room events are available.`,
      decisions: []
    };
  }

  async relevantMessages(input: {
    roomId: string;
    taskId: string;
    queryTerms: readonly string[];
    excludeEventIds: readonly string[];
    limit: 20;
  }): Promise<readonly ContextMessage[]> {
    void input.taskId;
    const excluded = new Set(input.excludeEventIds);
    const terms = input.queryTerms.map((term) => term.toLowerCase());
    return this.messageRows(input.roomId, 1_000)
      .map(asMessage)
      .filter((message): message is NonNullable<typeof message> => message !== null)
      .filter((message) => !excluded.has(message.eventId)
        && (terms.length === 0 || terms.some((term) => message.body.toLowerCase().includes(term))))
      .slice(-input.limit)
      .map(toContextMessage);
  }

  async peerArtifacts(input: {
    taskId: string;
    role: "lead" | "collaborator";
    messageLimit: 12;
  }): Promise<ContextBundlePayload["peer"]> {
    const task = this.database.prepare("SELECT room_id AS roomId FROM tasks WHERE id = ?").get(input.taskId) as { roomId: string } | undefined;
    const peerRoles = input.role === "lead" ? new Set(["reviewer", "collaborator"]) : new Set(["lead"]);
    const messages = task
      ? this.messageRows(task.roomId, 1_000)
          .map(asMessage)
          .filter((message): message is NonNullable<typeof message> => message !== null && message.runRole !== null)
          .filter((message) => peerRoles.has(message.runRole!))
          .slice(-input.messageLimit)
          .map(toContextMessage)
      : [];
    const peerWorktree = this.artifacts.getWorktree(input.taskId, input.role === "lead" ? "collaborator" : "lead");
    const checkpoint = peerWorktree
      ? this.artifacts.listCheckpoints(input.taskId)
          .filter(({ worktreeId }) => worktreeId === peerWorktree.id)
          .at(-1)
      : undefined;
    const testRows = this.database.prepare(
      "SELECT command_id AS commandId, exit_code AS exitCode FROM test_results WHERE task_id = ? ORDER BY created_at DESC LIMIT 20"
    ).all(input.taskId) as Array<{ commandId: string; exitCode: number }>;
    return {
      messages,
      checkpointOid: checkpoint?.oid ?? null,
      diffSummary: checkpoint ? `Peer checkpoint ${checkpoint.oid}` : null,
      tests: testRows.map((row) => `${row.commandId}: ${Number(row.exitCode) === 0 ? "passed" : "failed"}`),
      toolSummaries: []
    };
  }

  private messageRows(roomId: string, limit: number): EventRow[] {
    return (this.database.prepare(`SELECT id, room_seq, actor, event_type, payload_json FROM (
        SELECT id, room_seq, actor, event_type, payload_json
        FROM room_events WHERE room_id = ? AND event_type IN ('message.posted', 'agent.run')
        ORDER BY room_seq DESC LIMIT ?
      ) ORDER BY room_seq ASC`).all(roomId, limit) as unknown as EventRow[]);
  }
}
