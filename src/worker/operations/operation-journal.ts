import type { Database } from "../storage/database";
import type { ProviderProcessIdentity } from "../process/process-identity";

export type OperationStatus = "intent" | "executing" | "observed" | "completed" | "needs_attention";

export interface OperationRecord<E = Record<string, unknown>, O = Record<string, unknown>> {
  id: string;
  projectId: string;
  taskId: string | null;
  repositoryCommonDirRealpath: string;
  operationType: string;
  idempotencyKey: string;
  expected: E;
  status: OperationStatus;
  observation: O | null;
  workerGeneration: string;
  createdAt: string;
  updatedAt: string;
}

export type OperationIntentRecord<E = Record<string, unknown>> = Omit<
  OperationRecord<E, never>,
  "status" | "observation"
> & {
  status: "intent";
  observation: null;
};

export interface RecordIntentResult<E> {
  record: OperationRecord<E, never>;
  created: boolean;
}

interface OperationRow {
  id: string;
  project_id: string;
  task_id: string | null;
  repository_common_dir_realpath: string;
  operation_type: string;
  idempotency_key: string;
  expected_json: string;
  status: OperationStatus;
  observation_json: string | null;
  worker_generation: string;
  created_at: string;
  updated_at: string;
}

const OPERATION_COLUMNS = [
  "id", "project_id", "task_id", "repository_common_dir_realpath", "operation_type",
  "idempotency_key", "expected_json", "status", "observation_json", "worker_generation",
  "created_at", "updated_at"
].join(", ");

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("OPERATION_JSON_MUST_BE_FINITE");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  throw new TypeError("OPERATION_JSON_VALUE_INVALID");
}

function mapOperation<E = Record<string, unknown>, O = Record<string, unknown>>(
  row: OperationRow
): OperationRecord<E, O> {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    repositoryCommonDirRealpath: row.repository_common_dir_realpath,
    operationType: row.operation_type,
    idempotencyKey: row.idempotency_key,
    expected: JSON.parse(row.expected_json) as E,
    status: row.status,
    observation: row.observation_json === null ? null : JSON.parse(row.observation_json) as O,
    workerGeneration: row.worker_generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class OperationJournal {
  constructor(private readonly db: Database) {}

  recordIntent<E>(record: OperationIntentRecord<E>): RecordIntentResult<E> {
    if ((record as OperationRecord<E, unknown>).status !== "intent") {
      throw new Error("OPERATION_INTENT_STATUS_REQUIRED");
    }
    if ((record as OperationRecord<E, unknown>).observation !== null) {
      throw new Error("OPERATION_INTENT_OBSERVATION_MUST_BE_NULL");
    }
    const expectedJson = canonicalJson(record.expected);
    const existingRow = this.db.prepare(`SELECT ${OPERATION_COLUMNS} FROM operation_journal WHERE idempotency_key = ?`)
      .get(record.idempotencyKey) as OperationRow | undefined;
    if (existingRow) {
      if (existingRow.expected_json !== expectedJson) {
        throw new Error("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INTENT");
      }
      return { record: mapOperation<E, never>(existingRow), created: false };
    }
    this.db.prepare(`INSERT INTO operation_journal(${OPERATION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        record.id,
        record.projectId,
        record.taskId,
        record.repositoryCommonDirRealpath,
        record.operationType,
        record.idempotencyKey,
        expectedJson,
        "intent",
        null,
        record.workerGeneration,
        record.createdAt,
        record.updatedAt
      );
    return {
      record: {
        ...record,
        expected: JSON.parse(expectedJson) as E,
        status: "intent",
        observation: null
      },
      created: true
    };
  }

  markExecuting(id: string): void {
    this.transition(id, ["intent"], "executing");
  }

  recordObservation<O>(id: string, observation: O): void {
    const current = this.getRequired(id);
    if (current.status !== "executing") {
      throw new Error(`OPERATION_STATUS_PRECONDITION:${id}:executing:${current.status}`);
    }
    this.db.prepare("UPDATE operation_journal SET status = 'observed', observation_json = ? WHERE id = ? AND status = 'executing'")
      .run(canonicalJson(observation), id);
  }

  complete(id: string): void {
    this.transition(id, ["observed"], "completed");
  }

  needsAttention(id: string, observation: Record<string, unknown>): void {
    const current = this.getRequired(id);
    if (current.status === "completed") throw new Error(`OPERATION_ALREADY_COMPLETED:${id}`);
    this.db.prepare("UPDATE operation_journal SET status = 'needs_attention', observation_json = ? WHERE id = ? AND status <> 'completed'")
      .run(canonicalJson(observation), id);
  }

  getByIdempotencyKey(key: string): OperationRecord | null {
    const row = this.db.prepare(`SELECT ${OPERATION_COLUMNS} FROM operation_journal WHERE idempotency_key = ?`)
      .get(key) as OperationRow | undefined;
    return row ? mapOperation(row) : null;
  }

  listIncomplete(projectId?: string): OperationRecord[] {
    const rows = projectId === undefined
      ? this.db.prepare(`SELECT ${OPERATION_COLUMNS} FROM operation_journal WHERE status <> 'completed' ORDER BY created_at, id`).all()
      : this.db.prepare(`SELECT ${OPERATION_COLUMNS} FROM operation_journal WHERE project_id = ? AND status <> 'completed' ORDER BY created_at, id`).all(projectId);
    return (rows as unknown as OperationRow[]).map((row) => mapOperation(row));
  }

  reconcile(
    id: string,
    observation: Record<string, unknown>,
    outcome: "applied" | "not_applied" | "conflict" | "uncertain"
  ): void {
    const current = this.getRequired(id);
    if (current.status === "completed") return;
    this.db.prepare(
      "UPDATE operation_journal SET status = ?, observation_json = ? WHERE id = ? AND status <> 'completed'"
    ).run(outcome === "applied" ? "completed" : "needs_attention", canonicalJson({ outcome, actual: observation }), id);
  }

  recordProviderIdentity(runId: string, identity: ProviderProcessIdentity, at: string): void {
    const result = this.db.prepare(`UPDATE operation_journal SET provider_run_id = ?, process_identity_json = ?, updated_at = ?
      WHERE operation_type = 'provider_process' AND provider_run_id IS NULL AND json_extract(expected_json, '$.runId') = ?`)
      .run(runId, canonicalJson(identity), at, runId);
    if (result.changes !== 1) throw new Error(`PROVIDER_PROCESS_INTENT_NOT_FOUND:${runId}`);
  }

  recordProviderSignal(runId: string, signal: "abort" | "SIGTERM" | "SIGKILL", at: string): void {
    const result = this.db.prepare("UPDATE operation_journal SET last_signal = ?, signal_observed_at = ?, updated_at = ? WHERE provider_run_id = ? AND status <> 'completed'")
      .run(signal, at, at, runId);
    if (result.changes !== 1) throw new Error(`PROVIDER_PROCESS_NOT_FOUND:${runId}`);
  }

  completeProviderProcess(runId: string, at: string): void {
    this.db.prepare("UPDATE operation_journal SET status = 'completed', updated_at = ? WHERE provider_run_id = ? AND status <> 'completed'").run(at, runId);
  }

  private getRequired(id: string): OperationRecord {
    const row = this.db.prepare(`SELECT ${OPERATION_COLUMNS} FROM operation_journal WHERE id = ?`)
      .get(id) as OperationRow | undefined;
    if (!row) throw new Error(`OPERATION_NOT_FOUND:${id}`);
    return mapOperation(row);
  }

  private transition(id: string, expected: OperationStatus[], next: OperationStatus): void {
    const current = this.getRequired(id);
    if (!expected.includes(current.status)) {
      throw new Error(`OPERATION_STATUS_PRECONDITION:${id}:${expected.join("|")}:${current.status}`);
    }
    const placeholders = expected.map(() => "?").join(", ");
    const result = this.db.prepare(`UPDATE operation_journal SET status = ? WHERE id = ? AND status IN (${placeholders})`)
      .run(next, id, ...expected);
    if (result.changes !== 1) {
      throw new Error(`OPERATION_STATUS_PRECONDITION:${id}:${expected.join("|")}:${current.status}`);
    }
  }
}
