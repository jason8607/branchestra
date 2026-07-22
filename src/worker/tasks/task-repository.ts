import type {
  AgentRunRecord,
  TaskRecord,
  TaskTransition
} from "../../shared/contracts/domain";
import type { Database } from "../storage/database";
import type { EventStore } from "../storage/event-store";

interface TaskRow {
  id: string;
  room_id: string;
  project_id: string;
  request_event_id: string;
  request_text: string;
  lead_provider: TaskRecord["leadProvider"];
  target_ref: string;
  base_oid: string;
  state: TaskRecord["state"];
  interrupted_from_state: TaskRecord["interruptedFromState"];
  collaboration_rounds_used: number;
  collaboration_round_budget: number;
  human_revision_count: number;
  revision_kind: TaskRecord["revisionKind"];
  scope_approval_id: string | null;
  active_candidate_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

interface AgentRunRow {
  id: string;
  task_id: string;
  provider: AgentRunRecord["provider"];
  role: AgentRunRecord["role"];
  provider_session_id: string | null;
  context_version: number;
  context_hash: `sha256:${string}`;
  state: AgentRunRecord["state"];
  started_at: string;
  finished_at: string | null;
}

const TASK_COLUMNS = [
  "id", "room_id", "project_id", "request_event_id", "request_text", "lead_provider",
  "target_ref", "base_oid", "state", "interrupted_from_state", "collaboration_rounds_used",
  "collaboration_round_budget", "human_revision_count", "revision_kind", "scope_approval_id",
  "active_candidate_id", "failure_code", "failure_message", "version", "created_at", "updated_at"
].join(", ");

const RUN_COLUMNS = [
  "id", "task_id", "provider", "role", "provider_session_id", "context_version", "context_hash",
  "state", "started_at", "finished_at"
].join(", ");

function mapTask(row: TaskRow): TaskRecord {
  const hasFailure = row.failure_code !== null || row.failure_message !== null;
  if (hasFailure && (row.failure_code === null || row.failure_message === null)) {
    throw new Error(`TASK_FAILURE_COLUMNS_INCONSISTENT:${row.id}`);
  }
  return {
    id: row.id,
    roomId: row.room_id,
    projectId: row.project_id,
    requestEventId: row.request_event_id,
    requestText: row.request_text,
    leadProvider: row.lead_provider,
    targetRef: row.target_ref,
    baseOid: row.base_oid,
    state: row.state,
    interruptedFromState: row.interrupted_from_state,
    collaborationRoundsUsed: row.collaboration_rounds_used,
    collaborationRoundBudget: row.collaboration_round_budget,
    humanRevisionCount: row.human_revision_count,
    revisionKind: row.revision_kind,
    scopeApprovalId: row.scope_approval_id,
    activeCandidateId: row.active_candidate_id,
    failure: row.failure_code === null ? null : { code: row.failure_code, message: row.failure_message as string },
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapRun(row: AgentRunRow): AgentRunRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    provider: row.provider,
    role: row.role,
    providerSessionId: row.provider_session_id,
    contextVersion: row.context_version,
    contextHash: row.context_hash,
    state: row.state,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}

export class TaskRepository {
  constructor(
    private readonly db: Database,
    private readonly events: EventStore
  ) {}

  insert(task: TaskRecord): void {
    this.db.prepare(`INSERT INTO tasks(${TASK_COLUMNS}) VALUES (${TASK_COLUMNS.split(", ").map(() => "?").join(", ")})`)
      .run(
        task.id,
        task.roomId,
        task.projectId,
        task.requestEventId,
        task.requestText,
        task.leadProvider,
        task.targetRef,
        task.baseOid,
        task.state,
        task.interruptedFromState,
        task.collaborationRoundsUsed,
        task.collaborationRoundBudget,
        task.humanRevisionCount,
        task.revisionKind,
        task.scopeApprovalId,
        task.activeCandidateId,
        task.failure?.code ?? null,
        task.failure?.message ?? null,
        task.version,
        task.createdAt,
        task.updatedAt
      );
  }

  get(taskId: string): TaskRecord | null {
    const row = this.db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`).get(taskId) as TaskRow | undefined;
    return row ? mapTask(row) : null;
  }

  getRequired(taskId: string): TaskRecord {
    const task = this.get(taskId);
    if (!task) throw new Error(`TASK_NOT_FOUND:${taskId}`);
    return task;
  }

  listNonTerminal(): TaskRecord[] {
    const rows = this.db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE state NOT IN ('Completed', 'Cancelled', 'Failed') ORDER BY created_at, id`).all() as unknown as TaskRow[];
    return rows.map(mapTask);
  }

  updateState(next: TaskRecord, expectedVersion: number): void {
    const result = this.db.prepare(`
      UPDATE tasks SET
        room_id = ?, project_id = ?, request_event_id = ?, request_text = ?, lead_provider = ?,
        target_ref = ?, base_oid = ?, state = ?, interrupted_from_state = ?,
        collaboration_rounds_used = ?, collaboration_round_budget = ?, human_revision_count = ?,
        revision_kind = ?, scope_approval_id = ?, active_candidate_id = ?, failure_code = ?,
        failure_message = ?, version = ?, created_at = ?, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(
      next.roomId,
      next.projectId,
      next.requestEventId,
      next.requestText,
      next.leadProvider,
      next.targetRef,
      next.baseOid,
      next.state,
      next.interruptedFromState,
      next.collaborationRoundsUsed,
      next.collaborationRoundBudget,
      next.humanRevisionCount,
      next.revisionKind,
      next.scopeApprovalId,
      next.activeCandidateId,
      next.failure?.code ?? null,
      next.failure?.message ?? null,
      next.version,
      next.createdAt,
      next.updatedAt,
      next.id,
      expectedVersion
    );
    if (result.changes !== 1) throw new Error(`TASK_VERSION_CONFLICT:${next.id}`);
  }

  applyTransition(transition: TaskTransition, idempotencyKey: string): TaskRecord {
    if (transition.previous.id !== transition.next.id) {
      throw new Error("TASK_TRANSITION_ID_MISMATCH");
    }
    return this.db.transaction(() => {
      this.updateState(transition.next, transition.previous.version);
      const common = {
        id: idempotencyKey,
        roomId: transition.next.roomId,
        actor: "system" as const,
        createdAt: transition.next.updatedAt
      };
      if (transition.event.type === "task.transitioned") {
        this.events.append({ ...common, type: transition.event.type, payload: transition.event.payload });
      } else {
        this.events.append({ ...common, type: transition.event.type, payload: transition.event.payload });
      }
      return transition.next;
    });
  }

  insertRun(run: AgentRunRecord): void {
    this.db.prepare(`INSERT INTO agent_runs(${RUN_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        run.id,
        run.taskId,
        run.provider,
        run.role,
        run.providerSessionId,
        run.contextVersion,
        run.contextHash,
        run.state,
        run.startedAt,
        run.finishedAt
      );
  }

  getRun(runId: string): AgentRunRecord | null {
    const row = this.db.prepare(`SELECT ${RUN_COLUMNS} FROM agent_runs WHERE id = ?`).get(runId) as AgentRunRow | undefined;
    return row ? mapRun(row) : null;
  }

  listRuns(taskId: string): AgentRunRecord[] {
    const rows = this.db.prepare(`SELECT ${RUN_COLUMNS} FROM agent_runs WHERE task_id = ? ORDER BY started_at, id`).all(taskId) as unknown as AgentRunRow[];
    return rows.map(mapRun);
  }

  updateRunState(
    runId: string,
    state: AgentRunRecord["state"],
    finishedAt: string | null
  ): void {
    const result = this.db.prepare("UPDATE agent_runs SET state = ?, finished_at = ? WHERE id = ?")
      .run(state, finishedAt, runId);
    if (result.changes !== 1) throw new Error(`AGENT_RUN_NOT_FOUND:${runId}`);
  }
}
