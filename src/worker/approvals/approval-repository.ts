import type { ApprovalReceipt, ApprovalRequest } from "../../shared/contracts/domain";
import type { Database } from "../storage/database";
import { canonicalJson } from "./canonical-json";

interface ApprovalRequestRow {
  id: string;
  task_id: string;
  kind: ApprovalRequest["kind"];
  scope_json: string;
  scope_hash: `sha256:${string}`;
  requested_generation: string;
  status: ApprovalRequest["status"];
  requested_at: string;
}

interface ApprovalRow {
  id: string;
  request_id: string;
  task_id: string;
  kind: ApprovalReceipt["kind"];
  decision: ApprovalReceipt["decision"];
  scope_json: string;
  scope_hash: `sha256:${string}`;
  worker_generation: string;
  survives_worker_restart: number;
  decided_at: string;
}

const REQUEST_COLUMNS = [
  "id", "task_id", "kind", "scope_json", "scope_hash", "requested_generation", "status",
  "requested_at"
].join(", ");

const APPROVAL_COLUMNS = [
  "id", "request_id", "task_id", "kind", "decision", "scope_json", "scope_hash",
  "worker_generation", "survives_worker_restart", "decided_at"
].join(", ");

function mapRequest(row: ApprovalRequestRow): ApprovalRequest {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    scope: JSON.parse(row.scope_json) as ApprovalRequest["scope"],
    scopeHash: row.scope_hash,
    requestedGeneration: row.requested_generation,
    status: row.status,
    requestedAt: row.requested_at
  } as ApprovalRequest;
}

function mapApproval(row: ApprovalRow): ApprovalReceipt {
  return {
    id: row.id,
    requestId: row.request_id,
    taskId: row.task_id,
    kind: row.kind,
    scope: JSON.parse(row.scope_json) as ApprovalReceipt["scope"],
    decision: row.decision,
    scopeHash: row.scope_hash,
    workerGeneration: row.worker_generation,
    survivesWorkerRestart: row.survives_worker_restart === 1,
    decidedAt: row.decided_at
  } as ApprovalReceipt;
}

function assertRestartSurvival(receipt: ApprovalReceipt): void {
  if ((receipt.kind === "task_scope") !== receipt.survivesWorkerRestart) {
    throw new Error(`APPROVAL_RESTART_SURVIVAL_INVALID:${receipt.kind}`);
  }
}

function assertReceiptMatchesRequest(
  request: ApprovalRequest,
  receipt: ApprovalReceipt
): void {
  if (
    receipt.requestId !== request.id
    || receipt.taskId !== request.taskId
    || receipt.kind !== request.kind
    || receipt.scopeHash !== request.scopeHash
    || canonicalJson(receipt.scope) !== canonicalJson(request.scope)
  ) {
    throw new Error(`APPROVAL_RECEIPT_MISMATCH:${request.id}`);
  }
  if (receipt.workerGeneration !== request.requestedGeneration) {
    throw new Error(`APPROVAL_GENERATION_MISMATCH:${request.id}`);
  }
  assertRestartSurvival(receipt);
}

export class ApprovalRepository {
  constructor(private readonly db: Database) {}

  insertRequest(request: ApprovalRequest): void {
    this.db.prepare(`INSERT INTO approval_requests(${REQUEST_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        request.id,
        request.taskId,
        request.kind,
        canonicalJson(request.scope),
        request.scopeHash,
        request.requestedGeneration,
        request.status,
        request.requestedAt
      );
  }

  getRequest(requestId: string): ApprovalRequest | null {
    const row = this.db.prepare(`SELECT ${REQUEST_COLUMNS} FROM approval_requests WHERE id = ?`)
      .get(requestId) as ApprovalRequestRow | undefined;
    return row ? mapRequest(row) : null;
  }

  getPendingRequest(taskId: string): ApprovalRequest | null {
    const row = this.db.prepare(`SELECT ${REQUEST_COLUMNS} FROM approval_requests WHERE task_id = ? AND status = 'pending' ORDER BY requested_at DESC, id DESC LIMIT 1`)
      .get(taskId) as ApprovalRequestRow | undefined;
    return row ? mapRequest(row) : null;
  }

  decideRequest(requestId: string, receipt: ApprovalReceipt): void {
    this.db.transaction(() => {
      const request = this.getRequest(requestId);
      if (!request || request.status !== "pending") {
        throw new Error(`APPROVAL_REQUEST_NOT_PENDING:${requestId}`);
      }
      assertReceiptMatchesRequest(request, receipt);
      const decided = this.db.prepare("UPDATE approval_requests SET status = 'decided' WHERE id = ? AND status = 'pending'")
        .run(requestId);
      if (decided.changes !== 1) throw new Error(`APPROVAL_REQUEST_NOT_PENDING:${requestId}`);
      this.insert(receipt);
    });
  }

  insert(receipt: ApprovalReceipt): void {
    const request = this.getRequest(receipt.requestId);
    if (!request) throw new Error(`APPROVAL_REQUEST_NOT_FOUND:${receipt.requestId}`);
    assertReceiptMatchesRequest(request, receipt);
    this.db.prepare(`INSERT INTO approvals(${APPROVAL_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        receipt.id,
        receipt.requestId,
        receipt.taskId,
        receipt.kind,
        receipt.decision,
        canonicalJson(receipt.scope),
        receipt.scopeHash,
        receipt.workerGeneration,
        receipt.survivesWorkerRestart ? 1 : 0,
        receipt.decidedAt
      );
  }

  get(approvalId: string): ApprovalReceipt | null {
    const row = this.db.prepare(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE id = ?`)
      .get(approvalId) as ApprovalRow | undefined;
    return row ? mapApproval(row) : null;
  }

  getRequired(approvalId: string): ApprovalReceipt {
    const approval = this.get(approvalId);
    if (!approval) throw new Error(`APPROVAL_NOT_FOUND:${approvalId}`);
    return approval;
  }

  findApproved(
    taskId: string,
    kind: ApprovalReceipt["kind"],
    scopeHash: string
  ): ApprovalReceipt | null {
    const row = this.db.prepare(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE task_id = ? AND kind = ? AND scope_hash = ? AND decision = 'approved' ORDER BY decided_at DESC, id DESC LIMIT 1`)
      .get(taskId, kind, scopeHash) as ApprovalRow | undefined;
    return row ? mapApproval(row) : null;
  }

  listForTask(taskId: string): ApprovalReceipt[] {
    const rows = this.db.prepare(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE task_id = ? ORDER BY decided_at, id`)
      .all(taskId) as unknown as ApprovalRow[];
    return rows.map(mapApproval);
  }

  invalidateSensitiveFromOlderGeneration(currentGeneration: string): string[] {
    return this.db.transaction(() => {
      const rows = this.db.prepare("SELECT id FROM approvals WHERE survives_worker_restart = 0 AND worker_generation <> ? ORDER BY id")
        .all(currentGeneration) as unknown as Array<{ id: string }>;
      if (rows.length > 0) {
        this.db.prepare("DELETE FROM approvals WHERE survives_worker_restart = 0 AND worker_generation <> ?")
          .run(currentGeneration);
      }
      return rows.map((row) => row.id);
    });
  }
}
