import type { ProviderId } from "../../shared/contracts/provider";

export interface RecoveryBrief {
  interruptedRunId: string; providerSessionId: string; lastDurableProviderSeq: number; lastContextHash: string;
  latestCheckpointOid: string | null; diffSummary: string | null; testSummaries: readonly string[];
  instruction: "Do not replay external side effects. Continue from the durable state below.";
}
export interface SavedProviderSession {
  runId: string; provider: ProviderId; providerSessionId: string; contextHash: string; lastProviderSeq: number;
  resumeState: "active" | "interrupted" | "resumable" | "replaced" | "closed"; updatedAt: string;
}
interface SessionRepositoryPort {
  requireResumableSession(runId: string): SavedProviderSession;
  upsertSession(record: SavedProviderSession): void;
  markSessionReplaced(runId: string, replacementRunId: string, updatedAt: string): void;
}
interface AdapterPort {
  resumeRun(request: unknown): Promise<{ runId: string }>;
  startRun(request: unknown): Promise<{ runId: string }>;
}
export class ProviderSessionService {
  constructor(private readonly deps: {
    repository: SessionRepositoryPort;
    now(): string;
    classifyResumeUnavailable(error: unknown): boolean;
  }) {}

  recordStarted(input: { runId: string; provider: ProviderId; providerSessionId: string; contextHash: string; providerSeq: number }): void {
    this.deps.repository.upsertSession({ ...input, lastProviderSeq: input.providerSeq, resumeState: "active", updatedAt: this.deps.now() });
  }

  async resumeOrRecover(input: {
    interruptedRunId: string;
    adapter: AdapterPort;
    toResumeRequest(saved: SavedProviderSession): unknown;
    buildRecoveryBrief(saved: SavedProviderSession): Promise<RecoveryBrief>;
    buildFreshContext(brief: RecoveryBrief): Promise<unknown>;
    toRecoveryStartRequest(context: unknown, brief: RecoveryBrief): unknown;
  }): Promise<{ strategy: "resumed_session" | "new_session_with_brief"; handle: { runId: string } }> {
    const saved = this.deps.repository.requireResumableSession(input.interruptedRunId);
    try {
      const handle = await input.adapter.resumeRun(input.toResumeRequest(saved));
      return { strategy: "resumed_session", handle };
    } catch (error) {
      if (!this.deps.classifyResumeUnavailable(error)) throw error;
      const brief = await input.buildRecoveryBrief(saved);
      const context = await input.buildFreshContext(brief);
      const handle = await input.adapter.startRun(input.toRecoveryStartRequest(context, brief));
      this.deps.repository.markSessionReplaced(saved.runId, handle.runId, this.deps.now());
      return { strategy: "new_session_with_brief", handle };
    }
  }
}
