import type { ContextBundle, ProviderHealth, ProviderId } from "../../shared/contracts/provider";
import { ContextBundleSchema } from "../../shared/contracts/provider";
import { stableJson } from "../context/stable-json";
import type { Database } from "./database";

export interface ProviderInstallationRecord {
  provider: ProviderId;
  executableRealpath: string;
  cliVersion: string;
  architecture: "arm64" | "x64";
  state: ProviderHealth["state"];
  checkedAt: string;
}

export interface ProviderSessionRecord {
  runId: string;
  provider: ProviderId;
  providerSessionId: string;
  contextHash: string;
  lastProviderSeq: number;
  resumeState: "active" | "interrupted" | "resumable" | "replaced" | "closed";
  updatedAt: string;
}

export class ProviderRepository {
  constructor(private readonly database: Database) {}

  getInstallation(provider: ProviderId): ProviderInstallationRecord | undefined {
    const row = this.database.prepare("SELECT * FROM provider_installations WHERE provider = ?").get(provider) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      provider: row.provider as ProviderId, executableRealpath: String(row.executable_realpath), cliVersion: String(row.cli_version),
      architecture: row.architecture as "arm64" | "x64", state: row.state as ProviderHealth["state"], checkedAt: String(row.checked_at),
    };
  }

  upsertInstallation(record: ProviderInstallationRecord): void {
    this.database.prepare(`INSERT INTO provider_installations(provider, executable_realpath, cli_version, architecture, state, checked_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(provider) DO UPDATE SET executable_realpath=excluded.executable_realpath,
      cli_version=excluded.cli_version, architecture=excluded.architecture, state=excluded.state, checked_at=excluded.checked_at`)
      .run(record.provider, record.executableRealpath, record.cliVersion, record.architecture, record.state, record.checkedAt);
  }

  saveContext(bundle: ContextBundle, runId: string, createdAt: string): ContextBundle {
    const parsed = ContextBundleSchema.parse(bundle);
    this.database.prepare(`INSERT OR IGNORE INTO context_bundles(id, run_id, room_id, task_id, version, hash, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`${runId}:${parsed.version}`, runId, parsed.roomId, parsed.taskId, parsed.version, parsed.hash, stableJson(parsed), createdAt);
    return this.getContextByHash(runId, parsed.hash) ?? parsed;
  }

  getContextByHash(runId: string, hash: string): ContextBundle | undefined {
    const row = this.database.prepare("SELECT payload_json FROM context_bundles WHERE run_id = ? AND hash = ?").get(runId, hash) as { payload_json: string } | undefined;
    return row ? ContextBundleSchema.parse(JSON.parse(row.payload_json)) : undefined;
  }

  appendRawEvent(input: { id?: string; runId: string; providerSeq: number; payload: unknown; receivedAt: string }): boolean;
  appendRawEvent(runId: string, providerSeq: number, payload: unknown, receivedAt: string): boolean;
  appendRawEvent(inputOrRunId: { id?: string; runId: string; providerSeq: number; payload: unknown; receivedAt: string } | string, providerSeq?: number, payload?: unknown, receivedAt?: string): boolean {
    const input = typeof inputOrRunId === "string"
      ? { runId: inputOrRunId, providerSeq: providerSeq!, payload, receivedAt: receivedAt!, id: `${inputOrRunId}:${providerSeq!}` }
      : { ...inputOrRunId, id: inputOrRunId.id ?? `${inputOrRunId.runId}:${inputOrRunId.providerSeq}` };
    return this.database.transaction(() => {
      const result = this.database.prepare(`INSERT OR IGNORE INTO provider_events(id, run_id, provider_seq, payload_json, received_at) VALUES (?, ?, ?, ?, ?)`)
        .run(input.id, input.runId, input.providerSeq, stableJson(input.payload), input.receivedAt);
      if (result.changes === 1) {
        this.database.prepare(`UPDATE provider_sessions SET last_provider_seq = CASE WHEN last_provider_seq < ? THEN ? ELSE last_provider_seq END,
          updated_at = ? WHERE run_id = ?`).run(input.providerSeq, input.providerSeq, input.receivedAt, input.runId);
      }
      return result.changes === 1;
    });
  }

  upsertSession(record: ProviderSessionRecord): void {
    this.database.prepare(`INSERT INTO provider_sessions(run_id, provider, provider_session_id, context_hash, last_provider_seq, resume_state, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET provider_session_id=excluded.provider_session_id,
      context_hash=excluded.context_hash, last_provider_seq=excluded.last_provider_seq, resume_state=excluded.resume_state, updated_at=excluded.updated_at`)
      .run(record.runId, record.provider, record.providerSessionId, record.contextHash, record.lastProviderSeq, record.resumeState, record.updatedAt);
  }

  getSession(runId: string): ProviderSessionRecord | undefined {
    const row = this.database.prepare("SELECT * FROM provider_sessions WHERE run_id = ?").get(runId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      runId: String(row.run_id), provider: row.provider as ProviderId, providerSessionId: String(row.provider_session_id),
      contextHash: String(row.context_hash), lastProviderSeq: Number(row.last_provider_seq),
      resumeState: row.resume_state as ProviderSessionRecord["resumeState"], updatedAt: String(row.updated_at),
    };
  }

  requireResumableSession(runId: string): ProviderSessionRecord {
    const session = this.getSession(runId);
    if (!session || (session.resumeState !== "interrupted" && session.resumeState !== "resumable")) throw new Error("PROVIDER_SESSION_NOT_RESUMABLE");
    return session;
  }

  markSessionInterrupted(runId: string, updatedAt: string): void {
    this.database.prepare("UPDATE provider_sessions SET resume_state = 'interrupted', updated_at = ? WHERE run_id = ? AND resume_state = 'active'").run(updatedAt, runId);
  }

  markSessionResumable(runId: string, updatedAt: string): void {
    this.database.prepare("UPDATE provider_sessions SET resume_state = 'resumable', updated_at = ? WHERE run_id = ? AND resume_state = 'interrupted'").run(updatedAt, runId);
  }

  markSessionReplaced(runId: string, _replacementRunId: string, updatedAt: string): void {
    this.database.prepare("UPDATE provider_sessions SET resume_state = 'replaced', updated_at = ? WHERE run_id = ? AND resume_state IN ('interrupted','resumable')").run(updatedAt, runId);
  }
}
