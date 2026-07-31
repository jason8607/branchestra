import type {
  AgentRunRecord,
  RoomEvent,
  TaskRecord,
  TaskTransition
} from "../../shared/contracts/domain";
import { TaskRecordSchema } from "../../shared/contracts/domain";
import type { Database } from "../storage/database";
import {
  assertCanonicalEventStore,
  type AppendRoomEventInput,
  type EventStore
} from "../storage/event-store";

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

interface EngineCommandRow {
  request_type: string;
  request_hash: string;
  status: string;
  response_json: string | null;
}

interface ServiceCommandRow {
  idempotency_key: string;
  task_id: string;
  request_type: string;
  request_hash: string;
  round: number | null;
  expected_task_version: number;
  status: "pending" | "completed" | "failed";
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
}

interface CollaborationRoundRow {
  task_id: string;
  round: number;
  request_idempotency_key: string;
  request_hash: string;
  purpose: "parallel_implementation" | "review";
  checkpoint_oid: string;
  state: "started" | "completed";
  findings_hash: string | null;
  findings_json: string | null;
  result_task_json: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface CollaborationRoundRecord {
  taskId: string;
  round: number;
  requestIdempotencyKey: string;
  requestHash: string;
  purpose: "parallel_implementation" | "review";
  checkpointOid: string;
  state: "started" | "completed";
  findingsHash: string | null;
  findings: string[] | null;
  resultTask: TaskRecord | null;
  createdAt: string;
  completedAt: string | null;
}

export type ServiceCommandReservation =
  | { kind: "reserved"; task: TaskRecord }
  | { kind: "replayed"; result: unknown };

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

function mapCollaborationRound(row: CollaborationRoundRow): CollaborationRoundRecord {
  return {
    taskId: row.task_id,
    round: row.round,
    requestIdempotencyKey: row.request_idempotency_key,
    requestHash: row.request_hash,
    purpose: row.purpose,
    checkpointOid: row.checkpoint_oid,
    state: row.state,
    findingsHash: row.findings_hash,
    findings: row.findings_json === null
      ? null
      : JSON.parse(row.findings_json) as string[],
    resultTask: row.result_task_json === null
      ? null
      : TaskRecordSchema.parse(JSON.parse(row.result_task_json)),
    createdAt: row.created_at,
    completedAt: row.completed_at
  };
}

export class TaskRepository {
  private readonly db: Database;
  private readonly events: EventStore;

  constructor(
    db: Database,
    events: EventStore
  ) {
    assertCanonicalEventStore(db, events);
    this.db = db;
    this.events = events;
  }

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
    if (this.hasPendingIntegration(next.id)) {
      throw new Error(`TASK_INTEGRATION_IN_PROGRESS:${next.id}`);
    }
    this.updateStateUnchecked(next, expectedVersion);
  }

  private updateStateUnchecked(next: TaskRecord, expectedVersion: number): void {
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
      if (this.hasPendingIntegration(transition.next.id)) {
        throw new Error(`TASK_INTEGRATION_IN_PROGRESS:${transition.next.id}`);
      }
      return this.applyTransitionUnchecked(transition, idempotencyKey);
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

  updateRunSession(
    runId: string,
    providerSessionId: string | null,
    state: AgentRunRecord["state"]
  ): void {
    const result = this.db.prepare(
      "UPDATE agent_runs SET provider_session_id = ?, state = ? WHERE id = ?"
    ).run(providerSessionId, state, runId);
    if (result.changes !== 1) throw new Error(`AGENT_RUN_NOT_FOUND:${runId}`);
  }

  replayEngineCommand(
    idempotencyKey: string,
    requestType: string,
    requestHash: string
  ): TaskRecord | null {
    const row = this.db.prepare(
      "SELECT request_type, request_hash, status, response_json FROM idempotency_records WHERE idempotency_key = ?"
    ).get(idempotencyKey) as EngineCommandRow | undefined;
    if (!row) return null;
    if (row.request_type !== requestType || row.request_hash !== requestHash) {
      throw new Error(`ENGINE_IDEMPOTENCY_KEY_CONFLICT:${idempotencyKey}`);
    }
    if (row.status !== "completed" || row.response_json === null) {
      throw new Error(`ENGINE_COMMAND_REQUIRES_RECONCILIATION:${idempotencyKey}`);
    }
    return TaskRecordSchema.parse(JSON.parse(row.response_json));
  }

  beginEngineCommand(input: {
    idempotencyKey: string;
    requestType: string;
    requestHash: string;
    workerGeneration: string;
    createdAt: string;
  }): void {
    this.db.prepare(`
      INSERT INTO idempotency_records(
        idempotency_key, request_type, request_hash, worker_generation, status, created_at
      ) VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(
      input.idempotencyKey,
      input.requestType,
      input.requestHash,
      input.workerGeneration,
      input.createdAt
    );
  }

  completeEngineCommand(
    idempotencyKey: string,
    task: TaskRecord,
    completedAt: string
  ): void {
    const result = this.db.prepare(`
      UPDATE idempotency_records
      SET status = 'completed', response_json = ?, completed_at = ?
      WHERE idempotency_key = ? AND status = 'pending'
    `).run(JSON.stringify(TaskRecordSchema.parse(task)), completedAt, idempotencyKey);
    if (result.changes !== 1) {
      throw new Error(`ENGINE_COMMAND_NOT_PENDING:${idempotencyKey}`);
    }
  }

  startCollaborationRound(input: {
    idempotencyKey: string;
    requestType: string;
    requestHash: string;
    workerGeneration: string;
    transition: TaskTransition;
    purpose: "parallel_implementation" | "review";
    checkpointOid: string;
    diffSummary: Extract<RoomEvent, { type: "review.started" }>["payload"]["diffSummary"];
    transitionEventId: string;
    reviewEventId: string;
    createdAt: string;
  }): { task: TaskRecord; event: Extract<RoomEvent, { type: "review.started" }> } {
    return this.db.transaction(() => {
      this.beginEngineCommand({
        idempotencyKey: input.idempotencyKey,
        requestType: input.requestType,
        requestHash: input.requestHash,
        workerGeneration: input.workerGeneration,
        createdAt: input.createdAt
      });
      const reviewed = this.applyTransitionUnchecked(
        input.transition,
        input.transitionEventId
      );
      this.db.prepare(`
        INSERT INTO collaboration_rounds(
          task_id, round, request_idempotency_key, request_hash, purpose,
          checkpoint_oid, state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'started', ?)
      `).run(
        reviewed.id,
        reviewed.collaborationRoundsUsed,
        input.idempotencyKey,
        input.requestHash,
        input.purpose,
        input.checkpointOid,
        input.createdAt
      );
      const event = this.events.append({
        id: input.reviewEventId,
        roomId: reviewed.roomId,
        type: "review.started",
        actor: "system",
        payload: {
          taskId: reviewed.id,
          round: reviewed.collaborationRoundsUsed,
          purpose: input.purpose,
          checkpointOid: input.checkpointOid,
          diffSummary: input.diffSummary
        },
        createdAt: input.createdAt
      });
      if (event.type !== "review.started") throw new Error("REVIEW_EVENT_TYPE_MISMATCH");
      return { task: reviewed, event };
    });
  }

  getCollaborationRound(taskId: string, round: number): CollaborationRoundRecord | null {
    const row = this.db.prepare(`
      SELECT task_id, round, request_idempotency_key, request_hash, purpose,
        checkpoint_oid, state, findings_hash, findings_json, result_task_json,
        created_at, completed_at
      FROM collaboration_rounds
      WHERE task_id = ? AND round = ?
    `).get(taskId, round) as CollaborationRoundRow | undefined;
    return row ? mapCollaborationRound(row) : null;
  }

  replayCollaborationCompletion(input: {
    taskId: string;
    idempotencyKey: string;
    requestType: string;
    requestHash: string;
  }): TaskRecord | null {
    const command = this.getServiceCommand(input.idempotencyKey);
    if (command === null) return null;
    this.assertServiceCommandIdentity(
      command,
      input.requestType,
      input.requestHash
    );
    if (command.task_id !== input.taskId) {
      throw new Error(`ENGINE_IDEMPOTENCY_KEY_CONFLICT:${input.idempotencyKey}`);
    }
    if (command.status === "pending") {
      throw new Error(
        `SERVICE_COMMAND_REQUIRES_RECONCILIATION:${input.idempotencyKey}`
      );
    }
    if (command.status === "failed") {
      this.throwServiceCommandFailure(command);
    }
    if (command.round === null || command.result_json === null) {
      throw new Error(
        `SERVICE_COMMAND_REQUIRES_RECONCILIATION:${input.idempotencyKey}`
      );
    }
    return TaskRecordSchema.parse(JSON.parse(command.result_json));
  }

  completeCollaborationRound(input: {
    taskId: string;
    round: number;
    idempotencyKey: string;
    requestType: string;
    requestHash: string;
    findingsHash: string;
    findings: string[];
    workerGeneration: string;
    transition: TaskTransition | null;
    transitionEventId: string;
    eventId: string;
    createdAt: string;
  }): {
    task: TaskRecord;
    event: Extract<RoomEvent, { type: "review.completed" }> | null;
  } {
    return this.db.transaction(() => {
      const replay = this.replayCollaborationCompletion({
        taskId: input.taskId,
        idempotencyKey: input.idempotencyKey,
        requestType: input.requestType,
        requestHash: input.requestHash
      });
      if (replay) return { task: replay, event: null };
      const round = this.getCollaborationRound(input.taskId, input.round);
      if (!round) throw new Error("DURABLE_REVIEW_CONTEXT_NOT_FOUND");
      if (round.state === "completed") {
        if (round.findingsHash !== input.findingsHash || round.resultTask === null) {
          throw new Error(`REVIEW_ROUND_ALREADY_COMPLETED:${input.round}`);
        }
        return { task: round.resultTask, event: null };
      }
      const current = this.getRequired(input.taskId);
      if (current.collaborationRoundsUsed !== input.round
        || (current.state !== "Review1" && current.state !== "Review2")) {
        throw new Error(`TASK_NOT_IN_REVIEW:${current.state}`);
      }
      this.insertServiceCommand({
        idempotencyKey: input.idempotencyKey,
        taskId: input.taskId,
        requestType: input.requestType,
        requestHash: input.requestHash,
        round: input.round,
        expectedTaskVersion: current.version,
        workerGeneration: input.workerGeneration,
        createdAt: input.createdAt
      });
      let result = current;
      if (input.transition !== null) {
        if (input.transition.previous.version !== current.version) {
          throw new Error(`TASK_VERSION_CONFLICT:${input.taskId}`);
        }
        result = this.applyTransitionUnchecked(
          input.transition,
          input.transitionEventId
        );
      }
      const event = this.events.append({
        id: input.eventId,
        roomId: result.roomId,
        type: "review.completed",
        actor: "system",
        payload: {
          taskId: result.id,
          round: input.round,
          checkpointOid: round.checkpointOid,
          findings: [...input.findings]
        },
        createdAt: input.createdAt
      });
      const completed = this.db.prepare(`
        UPDATE collaboration_rounds
        SET state = 'completed', findings_hash = ?, findings_json = ?,
          result_task_json = ?, completed_at = ?
        WHERE task_id = ? AND round = ? AND state = 'started'
      `).run(
        input.findingsHash,
        JSON.stringify(input.findings),
        JSON.stringify(TaskRecordSchema.parse(result)),
        input.createdAt,
        input.taskId,
        input.round
      );
      if (completed.changes !== 1) {
        throw new Error(`REVIEW_ROUND_FINALIZATION_CONFLICT:${input.round}`);
      }
      this.completeServiceCommandUnchecked(
        input.idempotencyKey,
        result,
        input.createdAt
      );
      if (event.type !== "review.completed") {
        throw new Error("REVIEW_EVENT_TYPE_MISMATCH");
      }
      return { task: result, event };
    });
  }

  reserveIntegrationCommand(input: {
    taskId: string;
    idempotencyKey: string;
    requestType: string;
    requestHash: string;
    workerGeneration: string;
    createdAt: string;
  }): ServiceCommandReservation {
    return this.db.transaction(() => {
      const existing = this.getServiceCommand(input.idempotencyKey);
      if (existing) {
        this.assertServiceCommandIdentity(existing, input.requestType, input.requestHash);
        if (existing.status === "pending") {
          throw new Error(`SERVICE_COMMAND_REQUIRES_RECONCILIATION:${input.idempotencyKey}`);
        }
        if (existing.status === "failed") {
          this.throwServiceCommandFailure(existing);
        }
        return {
          kind: "replayed",
          result: JSON.parse(existing.result_json ?? "null")
        };
      }
      const task = this.getRequired(input.taskId);
      if (task.state !== "Review1" && task.state !== "Review2") {
        throw new Error(`TASK_NOT_IN_INTEGRATION_PHASE:${task.state}`);
      }
      this.insertServiceCommand({
        ...input,
        round: null,
        expectedTaskVersion: task.version
      });
      return { kind: "reserved", task };
    });
  }

  completeIntegrationCommand(input: {
    idempotencyKey: string;
    result: unknown;
    transition: TaskTransition | null;
    transitionEventId: string;
    event: AppendRoomEventInput;
    completedAt: string;
  }): { task: TaskRecord; event: RoomEvent } {
    return this.db.transaction(() => {
      const command = this.getServiceCommand(input.idempotencyKey);
      if (!command || command.status !== "pending") {
        throw new Error(`SERVICE_COMMAND_NOT_PENDING:${input.idempotencyKey}`);
      }
      const current = this.getRequired(command.task_id);
      if (current.version !== command.expected_task_version) {
        throw new Error(`TASK_VERSION_CONFLICT:${current.id}`);
      }
      let resultTask = current;
      if (input.transition !== null) {
        if (input.transition.previous.version !== current.version) {
          throw new Error(`TASK_VERSION_CONFLICT:${current.id}`);
        }
        resultTask = this.applyTransitionUnchecked(
          input.transition,
          input.transitionEventId
        );
      }
      const event = this.events.append(input.event);
      this.completeServiceCommandUnchecked(
        input.idempotencyKey,
        input.result,
        input.completedAt
      );
      return { task: resultTask, event };
    });
  }

  failServiceCommand(
    idempotencyKey: string,
    code: string,
    message: string,
    completedAt: string
  ): void {
    const result = this.db.prepare(`
      UPDATE task_service_commands
      SET status = 'failed', error_code = ?, error_message = ?, completed_at = ?
      WHERE idempotency_key = ? AND status = 'pending'
    `).run(code, message, completedAt, idempotencyKey);
    if (result.changes !== 1) {
      throw new Error(`SERVICE_COMMAND_NOT_PENDING:${idempotencyKey}`);
    }
  }

  private applyTransitionUnchecked(
    transition: TaskTransition,
    idempotencyKey: string
  ): TaskRecord {
    this.updateStateUnchecked(transition.next, transition.previous.version);
    const common = {
      id: idempotencyKey,
      roomId: transition.next.roomId,
      actor: "system" as const,
      createdAt: transition.next.updatedAt
    };
    this.events.append({
      ...common,
      type: transition.event.type,
      payload: transition.event.payload
    } as AppendRoomEventInput);
    return transition.next;
  }

  private hasPendingIntegration(taskId: string): boolean {
    return this.db.prepare(`
      SELECT 1 FROM task_service_commands
      WHERE task_id = ?
        AND request_type = 'integration.integrateSelectedCheckpoints'
        AND status = 'pending'
      LIMIT 1
    `).get(taskId) !== undefined;
  }

  private getServiceCommand(idempotencyKey: string): ServiceCommandRow | null {
    const row = this.db.prepare(`
      SELECT idempotency_key, task_id, request_type, request_hash, round,
        expected_task_version, status, result_json, error_code, error_message
      FROM task_service_commands
      WHERE idempotency_key = ?
    `).get(idempotencyKey) as ServiceCommandRow | undefined;
    return row ?? null;
  }

  private assertServiceCommandIdentity(
    command: ServiceCommandRow,
    requestType: string,
    requestHash: string
  ): void {
    if (command.request_type !== requestType || command.request_hash !== requestHash) {
      throw new Error(`ENGINE_IDEMPOTENCY_KEY_CONFLICT:${command.idempotency_key}`);
    }
  }

  private throwServiceCommandFailure(command: ServiceCommandRow): never {
    throw new Error(
      command.error_message
      ?? command.error_code
      ?? "SERVICE_COMMAND_FAILED"
    );
  }

  private insertServiceCommand(input: {
    idempotencyKey: string;
    taskId: string;
    requestType: string;
    requestHash: string;
    round: number | null;
    expectedTaskVersion: number;
    workerGeneration: string;
    createdAt: string;
  }): void {
    this.db.prepare(`
      INSERT INTO task_service_commands(
        idempotency_key, task_id, request_type, request_hash, round,
        expected_task_version, worker_generation, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      input.idempotencyKey,
      input.taskId,
      input.requestType,
      input.requestHash,
      input.round,
      input.expectedTaskVersion,
      input.workerGeneration,
      input.createdAt
    );
  }

  private completeServiceCommandUnchecked(
    idempotencyKey: string,
    result: unknown,
    completedAt: string
  ): void {
    const updated = this.db.prepare(`
      UPDATE task_service_commands
      SET status = 'completed', result_json = ?, completed_at = ?
      WHERE idempotency_key = ? AND status = 'pending'
    `).run(JSON.stringify(result), completedAt, idempotencyKey);
    if (updated.changes !== 1) {
      throw new Error(`SERVICE_COMMAND_NOT_PENDING:${idempotencyKey}`);
    }
  }
}
