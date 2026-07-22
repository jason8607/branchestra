import type { Database } from "./database";

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
