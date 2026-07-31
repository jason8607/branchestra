import type {
  CheckpointRecord,
  IntegrationCandidate,
  TestResultRecord,
  WorktreeRecord
} from "../../shared/contracts/domain";
import type { Database } from "../storage/database";

interface WorktreeRow {
  id: string;
  task_id: string;
  role: WorktreeRecord["role"];
  path_realpath: string;
  branch_ref: string;
  base_oid: string;
  current_checkpoint_oid: string | null;
  retained: number;
  created_at: string;
}

interface CheckpointRow {
  id: string;
  task_id: string;
  worktree_id: string;
  author_provider: CheckpointRecord["authorProvider"];
  purpose: CheckpointRecord["purpose"];
  oid: string;
  immutable_ref: string;
  created_at: string;
}

interface CandidateRow {
  id: string;
  task_id: string;
  lead_worktree_id: string;
  target_ref: string;
  base_oid: string;
  candidate_oid: string;
  immutable_ref: string;
  diff_hash: `sha256:${string}`;
  test_set_hash: `sha256:${string}`;
  diff_summary_json: string;
  unresolved_json: string;
  verification_status: IntegrationCandidate["verificationStatus"];
  created_at: string;
}

interface TestResultRow {
  id: string;
  task_id: string;
  candidate_id: string;
  command_id: string;
  executable_realpath: string;
  argv_json: string;
  exit_code: number;
  stdout_hash: `sha256:${string}`;
  stderr_hash: `sha256:${string}`;
  duration_ms: number;
  log_reference: string;
  created_at: string;
}

const WORKTREE_COLUMNS = [
  "id", "task_id", "role", "path_realpath", "branch_ref", "base_oid",
  "current_checkpoint_oid", "retained", "created_at"
].join(", ");
const CHECKPOINT_COLUMNS = [
  "id", "task_id", "worktree_id", "author_provider", "purpose", "oid", "immutable_ref", "created_at"
].join(", ");
const CANDIDATE_COLUMNS = [
  "id", "task_id", "lead_worktree_id", "target_ref", "base_oid", "candidate_oid",
  "immutable_ref", "diff_hash", "test_set_hash", "diff_summary_json", "unresolved_json",
  "verification_status", "created_at"
].join(", ");
const TEST_RESULT_COLUMNS = [
  "id", "task_id", "candidate_id", "command_id", "executable_realpath", "argv_json",
  "exit_code", "stdout_hash", "stderr_hash", "duration_ms", "log_reference", "created_at"
].join(", ");

function mapWorktree(row: WorktreeRow): WorktreeRecord {
  if (row.retained !== 1) throw new Error(`WORKTREE_NOT_RETAINED:${row.id}`);
  return {
    id: row.id,
    taskId: row.task_id,
    role: row.role,
    pathRealpath: row.path_realpath,
    branchRef: row.branch_ref,
    baseOid: row.base_oid,
    currentCheckpointOid: row.current_checkpoint_oid,
    retained: true,
    createdAt: row.created_at
  };
}

function mapCheckpoint(row: CheckpointRow): CheckpointRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    worktreeId: row.worktree_id,
    authorProvider: row.author_provider,
    purpose: row.purpose,
    oid: row.oid,
    immutableRef: row.immutable_ref,
    createdAt: row.created_at
  };
}

function mapTestResult(row: TestResultRow): TestResultRecord {
  const argv = JSON.parse(row.argv_json) as unknown;
  if (!Array.isArray(argv) || argv.some((argument) => typeof argument !== "string")) {
    throw new Error(`TEST_RESULT_ARGV_INVALID:${row.id}`);
  }
  return {
    id: row.id,
    taskId: row.task_id,
    candidateId: row.candidate_id,
    commandId: row.command_id,
    executableRealpath: row.executable_realpath,
    argv,
    exitCode: row.exit_code,
    stdoutHash: row.stdout_hash,
    stderrHash: row.stderr_hash,
    durationMs: row.duration_ms,
    logReference: row.log_reference,
    createdAt: row.created_at
  };
}

export class GitArtifactRepository {
  constructor(private readonly db: Database) {}

  insertWorktree(record: WorktreeRecord): void {
    this.db.prepare(`INSERT INTO worktrees(${WORKTREE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        record.id,
        record.taskId,
        record.role,
        record.pathRealpath,
        record.branchRef,
        record.baseOid,
        record.currentCheckpointOid,
        1,
        record.createdAt
      );
  }

  getWorktree(taskId: string, role: "lead" | "collaborator"): WorktreeRecord | null {
    const row = this.db.prepare(`SELECT ${WORKTREE_COLUMNS} FROM worktrees WHERE task_id = ? AND role = ?`)
      .get(taskId, role) as WorktreeRow | undefined;
    return row ? mapWorktree(row) : null;
  }

  listWorktrees(taskId: string): WorktreeRecord[] {
    const rows = this.db.prepare(`SELECT ${WORKTREE_COLUMNS} FROM worktrees WHERE task_id = ? ORDER BY created_at, id`)
      .all(taskId) as unknown as WorktreeRow[];
    return rows.map(mapWorktree);
  }

  updateCheckpoint(worktreeId: string, oid: string): void {
    const result = this.db.prepare("UPDATE worktrees SET current_checkpoint_oid = ? WHERE id = ?")
      .run(oid, worktreeId);
    if (result.changes !== 1) throw new Error(`WORKTREE_NOT_FOUND:${worktreeId}`);
  }

  insertCheckpoint(record: CheckpointRecord): void {
    this.db.transaction(() => {
      const worktree = this.db.prepare("SELECT task_id FROM worktrees WHERE id = ?")
        .get(record.worktreeId) as { task_id: string } | undefined;
      if (!worktree) throw new Error(`WORKTREE_NOT_FOUND:${record.worktreeId}`);
      if (worktree.task_id !== record.taskId) throw new Error("CHECKPOINT_WORKTREE_TASK_MISMATCH");
      this.db.prepare(`INSERT INTO checkpoints(${CHECKPOINT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          record.id,
          record.taskId,
          record.worktreeId,
          record.authorProvider,
          record.purpose,
          record.oid,
          record.immutableRef,
          record.createdAt
        );
    });
  }

  persistCheckpoint(record: CheckpointRecord): void {
    this.db.transaction(() => {
      this.insertCheckpoint(record);
      this.updateCheckpoint(record.worktreeId, record.oid);
    });
  }

  getCheckpoint(checkpointId: string): CheckpointRecord | null {
    const row = this.db.prepare(`SELECT ${CHECKPOINT_COLUMNS} FROM checkpoints WHERE id = ?`)
      .get(checkpointId) as CheckpointRow | undefined;
    return row ? mapCheckpoint(row) : null;
  }

  listCheckpoints(taskId: string): CheckpointRecord[] {
    const rows = this.db.prepare(`SELECT ${CHECKPOINT_COLUMNS} FROM checkpoints WHERE task_id = ? ORDER BY created_at, id`)
      .all(taskId) as unknown as CheckpointRow[];
    return rows.map(mapCheckpoint);
  }

  insertCandidate(candidate: IntegrationCandidate, checkpointIds: string[]): void {
    if (candidate.selectedCheckpointIds.length !== checkpointIds.length
      || candidate.selectedCheckpointIds.some((checkpointId, index) => checkpointId !== checkpointIds[index])) {
      throw new Error("CANDIDATE_CHECKPOINT_ORDER_MISMATCH");
    }
    this.db.transaction(() => {
      const lead = this.db.prepare("SELECT task_id, role FROM worktrees WHERE id = ?")
        .get(candidate.leadWorktreeId) as { task_id: string; role: string } | undefined;
      if (!lead) throw new Error(`WORKTREE_NOT_FOUND:${candidate.leadWorktreeId}`);
      if (lead.task_id !== candidate.taskId || lead.role !== "lead") {
        throw new Error("CANDIDATE_LEAD_WORKTREE_MISMATCH");
      }
      for (const checkpointId of checkpointIds) {
        const checkpoint = this.db.prepare("SELECT task_id FROM checkpoints WHERE id = ?")
          .get(checkpointId) as { task_id: string } | undefined;
        if (!checkpoint) throw new Error(`CHECKPOINT_NOT_FOUND:${checkpointId}`);
        if (checkpoint.task_id !== candidate.taskId) throw new Error("CANDIDATE_CHECKPOINT_TASK_MISMATCH");
      }
      this.db.prepare(`INSERT INTO integration_candidates(${CANDIDATE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          candidate.id,
          candidate.taskId,
          candidate.leadWorktreeId,
          candidate.targetRef,
          candidate.baseOid,
          candidate.candidateOid,
          candidate.immutableRef,
          candidate.diffHash,
          candidate.testSetHash,
          JSON.stringify(candidate.diffSummary),
          JSON.stringify(candidate.unresolved),
          candidate.verificationStatus,
          candidate.createdAt
        );
      const insertSelection = this.db.prepare(
        "INSERT INTO candidate_checkpoints(candidate_id, checkpoint_id, ordinal) VALUES (?, ?, ?)"
      );
      checkpointIds.forEach((checkpointId, ordinal) => {
        insertSelection.run(candidate.id, checkpointId, ordinal);
      });
    });
  }

  getCandidate(candidateId: string): IntegrationCandidate | null {
    const row = this.db.prepare(`SELECT ${CANDIDATE_COLUMNS} FROM integration_candidates WHERE id = ?`)
      .get(candidateId) as CandidateRow | undefined;
    if (!row) return null;
    const selections = this.db.prepare(
      "SELECT checkpoint_id FROM candidate_checkpoints WHERE candidate_id = ? ORDER BY ordinal"
    ).all(candidateId) as unknown as Array<{ checkpoint_id: string }>;
    return {
      id: row.id,
      taskId: row.task_id,
      leadWorktreeId: row.lead_worktree_id,
      targetRef: row.target_ref,
      baseOid: row.base_oid,
      candidateOid: row.candidate_oid,
      immutableRef: row.immutable_ref,
      diffHash: row.diff_hash,
      testSetHash: row.test_set_hash,
      diffSummary: JSON.parse(row.diff_summary_json) as IntegrationCandidate["diffSummary"],
      selectedCheckpointIds: selections.map(({ checkpoint_id }) => checkpoint_id),
      testResults: this.listTestResults(candidateId),
      unresolved: JSON.parse(row.unresolved_json) as IntegrationCandidate["unresolved"],
      verificationStatus: row.verification_status,
      createdAt: row.created_at
    };
  }

  listTestResults(candidateId: string): TestResultRecord[] {
    const rows = this.db.prepare(`SELECT ${TEST_RESULT_COLUMNS} FROM test_results WHERE candidate_id = ? ORDER BY created_at, id`)
      .all(candidateId) as unknown as TestResultRow[];
    return rows.map(mapTestResult);
  }

  insertTestResult(result: TestResultRecord): void {
    const candidate = this.db.prepare("SELECT task_id FROM integration_candidates WHERE id = ?")
      .get(result.candidateId) as { task_id: string } | undefined;
    if (!candidate) throw new Error(`CANDIDATE_NOT_FOUND:${result.candidateId}`);
    if (candidate.task_id !== result.taskId) throw new Error("TEST_RESULT_CANDIDATE_TASK_MISMATCH");
    this.db.prepare(`INSERT INTO test_results(${TEST_RESULT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        result.id,
        result.taskId,
        result.candidateId,
        result.commandId,
        result.executableRealpath,
        JSON.stringify(result.argv),
        result.exitCode,
        result.stdoutHash,
        result.stderrHash,
        result.durationMs,
        result.logReference,
        result.createdAt
      );
  }
}
