import type { Database } from "./database";

export const TASK_ENGINE_SCHEMA_SQL = `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    request_event_id TEXT NOT NULL UNIQUE,
    request_text TEXT NOT NULL,
    lead_provider TEXT NOT NULL CHECK (lead_provider IN ('claude','codex')),
    target_ref TEXT NOT NULL,
    base_oid TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
      'AwaitingApproval','Preparing','Working','Checkpoint','Review1','Revision','Review2',
      'Candidate','HumanApproval','Merging','CancelRequested','Interrupted','Reconciling',
      'Completed','Cancelled','Failed'
    )),
    interrupted_from_state TEXT,
    collaboration_rounds_used INTEGER NOT NULL DEFAULT 0 CHECK (collaboration_rounds_used >= 0),
    collaboration_round_budget INTEGER NOT NULL DEFAULT 2 CHECK (collaboration_round_budget >= 0),
    human_revision_count INTEGER NOT NULL DEFAULT 0 CHECK (human_revision_count >= 0),
    revision_kind TEXT CHECK (revision_kind IS NULL OR revision_kind IN ('agent_review','human_directed')),
    scope_approval_id TEXT,
    active_candidate_id TEXT,
    failure_code TEXT,
    failure_message TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE approval_requests (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('task_scope','additional_round','external_operation','final_merge')),
    scope_json TEXT NOT NULL,
    scope_hash TEXT NOT NULL,
    requested_generation TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','decided')),
    requested_at TEXT NOT NULL
  );

  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE REFERENCES approval_requests(id) ON DELETE RESTRICT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('task_scope','additional_round','external_operation','final_merge')),
    decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
    scope_json TEXT NOT NULL,
    scope_hash TEXT NOT NULL,
    worker_generation TEXT NOT NULL,
    survives_worker_restart INTEGER NOT NULL CHECK (survives_worker_restart IN (0,1)),
    decided_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX approvals_scope_once ON approvals(task_id, kind, scope_hash, decision);

  CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    provider TEXT NOT NULL CHECK (provider IN ('claude','codex')),
    role TEXT NOT NULL CHECK (role IN ('lead','collaborator','reviewer')),
    provider_session_id TEXT,
    context_version INTEGER NOT NULL,
    context_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('starting','running','completed','cancelled','failed','interrupted')),
    started_at TEXT NOT NULL,
    finished_at TEXT
  );

  CREATE TABLE worktrees (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    role TEXT NOT NULL CHECK (role IN ('lead','collaborator')),
    path_realpath TEXT NOT NULL UNIQUE,
    branch_ref TEXT NOT NULL UNIQUE,
    base_oid TEXT NOT NULL,
    current_checkpoint_oid TEXT,
    retained INTEGER NOT NULL DEFAULT 1 CHECK (retained = 1),
    created_at TEXT NOT NULL,
    UNIQUE(task_id, role)
  );

  CREATE TABLE checkpoints (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE RESTRICT,
    author_provider TEXT NOT NULL CHECK (author_provider IN ('claude','codex')),
    purpose TEXT NOT NULL CHECK (purpose IN ('implementation','review','revision','candidate')),
    oid TEXT NOT NULL,
    immutable_ref TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE TRIGGER checkpoints_oid_immutable
  BEFORE UPDATE OF oid, immutable_ref ON checkpoints
  BEGIN SELECT RAISE(ABORT, 'CHECKPOINT_IMMUTABLE'); END;

  CREATE TABLE test_results (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    candidate_id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    executable_realpath TEXT NOT NULL,
    argv_json TEXT NOT NULL,
    exit_code INTEGER NOT NULL,
    stdout_hash TEXT NOT NULL,
    stderr_hash TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    log_reference TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(candidate_id, command_id)
  );

  CREATE TABLE integration_candidates (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    lead_worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE RESTRICT,
    target_ref TEXT NOT NULL,
    base_oid TEXT NOT NULL,
    candidate_oid TEXT NOT NULL,
    immutable_ref TEXT NOT NULL UNIQUE,
    diff_hash TEXT NOT NULL,
    test_set_hash TEXT NOT NULL,
    diff_summary_json TEXT NOT NULL,
    unresolved_json TEXT NOT NULL,
    verification_status TEXT NOT NULL CHECK (verification_status IN ('passed','failed')),
    created_at TEXT NOT NULL
  );

  CREATE TABLE candidate_checkpoints (
    candidate_id TEXT NOT NULL REFERENCES integration_candidates(id) ON DELETE RESTRICT,
    checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE RESTRICT,
    ordinal INTEGER NOT NULL,
    PRIMARY KEY(candidate_id, checkpoint_id),
    UNIQUE(candidate_id, ordinal)
  );

  CREATE TABLE operation_journal (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
    repository_common_dir_realpath TEXT NOT NULL,
    operation_type TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    expected_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('intent','executing','observed','completed','needs_attention')),
    observation_json TEXT,
    worker_generation TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX operation_journal_incomplete ON operation_journal(project_id, status);

  CREATE TABLE task_service_commands (
    idempotency_key TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    request_type TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    round INTEGER,
    expected_task_version INTEGER NOT NULL,
    worker_generation TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','completed','failed')),
    result_json TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE UNIQUE INDEX collaboration_round_completion_once
    ON task_service_commands(task_id, request_type, round)
    WHERE request_type = 'collaboration.completeReview';
  CREATE UNIQUE INDEX one_pending_checkpoint_integration
    ON task_service_commands(task_id)
    WHERE request_type = 'integration.integrateSelectedCheckpoints' AND status = 'pending';

  CREATE TABLE collaboration_rounds (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    round INTEGER NOT NULL CHECK (round > 0),
    request_idempotency_key TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('parallel_implementation','review')),
    checkpoint_oid TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('started','completed')),
    findings_hash TEXT,
    findings_json TEXT,
    result_task_json TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    PRIMARY KEY(task_id, round)
  );
`;

const DURABLE_TASK_SERVICE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS task_service_commands (
    idempotency_key TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    request_type TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    round INTEGER,
    expected_task_version INTEGER NOT NULL,
    worker_generation TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','completed','failed')),
    result_json TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS collaboration_round_completion_once
    ON task_service_commands(task_id, request_type, round)
    WHERE request_type = 'collaboration.completeReview';
  CREATE UNIQUE INDEX IF NOT EXISTS one_pending_checkpoint_integration
    ON task_service_commands(task_id)
    WHERE request_type = 'integration.integrateSelectedCheckpoints' AND status = 'pending';
  CREATE TABLE IF NOT EXISTS collaboration_rounds (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    round INTEGER NOT NULL CHECK (round > 0),
    request_idempotency_key TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('parallel_implementation','review')),
    checkpoint_oid TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('started','completed')),
    findings_hash TEXT,
    findings_json TEXT,
    result_task_json TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    PRIMARY KEY(task_id, round)
  );
`;

const migrations = [{
  version: 1,
  sql: `
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      repository_root TEXT NOT NULL UNIQUE,
      git_common_dir TEXT NOT NULL,
      display_name TEXT NOT NULL,
      head_oid TEXT NOT NULL,
      default_branch TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX rooms_project_created ON rooms(project_id, created_at, id);
    CREATE TABLE room_events (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      room_seq INTEGER NOT NULL CHECK(room_seq > 0),
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL CHECK(actor IN ('user','claude','codex','system')),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(room_id, room_seq)
    );
    CREATE INDEX room_events_replay ON room_events(room_id, room_seq);
    CREATE TABLE idempotency_records (
      idempotency_key TEXT PRIMARY KEY,
      request_type TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      worker_generation TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'completed')),
      response_json TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE worker_leases (
      lease_key INTEGER PRIMARY KEY CHECK(lease_key = 1),
      owner_instance_id TEXT NOT NULL,
      worker_generation TEXT NOT NULL,
      pid INTEGER NOT NULL,
      start_identity TEXT NOT NULL,
      heartbeat_ms INTEGER NOT NULL
    );
  `
}, {
  version: 2,
  sql: TASK_ENGINE_SCHEMA_SQL
}, {
  version: 3,
  sql: DURABLE_TASK_SERVICE_SCHEMA_SQL
}] as const;

export function runMigrations(database: Database): void {
  database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?");
  const record = database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)");
  for (const migration of migrations) {
    database.transaction(() => {
      if (applied.get(migration.version)) return;
      database.exec(migration.sql);
      record.run(migration.version, new Date().toISOString());
    });
  }
}
