import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderCapabilities, ProviderHealth, ProviderId } from "../../src/shared/contracts/provider";
import type { ProviderRunnerCommand } from "../../src/shared/contracts/provider-runner";
import { ApprovedCommandRunner } from "../../src/worker/approvals/approved-command-runner";
import { ContextBuilder } from "../../src/worker/context/context-builder";
import { ContextRepository } from "../../src/worker/context/context-repository";
import { RuntimeContextSource } from "../../src/worker/context/runtime-context-source";
import { createTaskRunContextPreparer } from "../../src/worker/context/task-run-context";
import { GitCommandRunner } from "../../src/worker/git/git-command-runner";
import { JournaledProcessRunner } from "../../src/worker/operations/journaled-process-runner";
import { CLAUDE_CAPABILITIES } from "../../src/provider-runner/claude-runtime";
import { CODEX_CAPABILITIES } from "../../src/provider-runner/codex-runtime";
import { normalizeClaudeEvent } from "../../src/worker/providers/normalization/claude-event";
import { normalizeCodexEvent } from "../../src/worker/providers/normalization/codex-event";
import { createProviderRegistry } from "../../src/worker/providers/provider-registry";
import { RegistryTaskProvider } from "../../src/worker/providers/registry-task-provider";
import { RunnerBackedAdapter, type RunnerPort } from "../../src/worker/providers/runner-backed-adapter";
import { CollaborationCoordinator } from "../../src/worker/tasks/collaboration-coordinator";
import { CandidateService } from "../../src/worker/tasks/candidate-service";
import type { TaskProviderPort } from "../../src/worker/tasks/provider-port";
import { createTaskEngineFixture } from "../fixtures/task-engine";

function health(provider: ProviderId, capabilities: ProviderCapabilities): ProviderHealth {
  return {
    provider,
    state: "ready",
    executableRealpath: `/private/tmp/branchestra-${provider}`,
    cliVersion: provider === "claude" ? "2.1.206" : "0.144.6",
    sdkVersion: provider === "claude" ? "0.3.216" : "0.144.6",
    architecture: "arm64",
    authLabel: "Subscription-only",
    capabilities,
    repairAction: null
  };
}

class FakeSdkRunner implements RunnerPort {
  readonly adaptersUsed: ProviderId[] = [];
  readonly commands: Array<Extract<ProviderRunnerCommand, { type: "run.start" | "run.resume" }>> = [];
  private session = 0;

  async launch(
    launch: Parameters<RunnerPort["launch"]>[0],
    accept: Parameters<RunnerPort["launch"]>[1]
  ) {
    return {
      send: async (command: ProviderRunnerCommand) => {
        if (command.type !== "run.start" && command.type !== "run.resume") return;
        this.adaptersUsed.push(command.provider);
        this.commands.push(command);
        const session = ++this.session;
        if (command.provider === "claude") {
          await writeFile(
            join(command.request.worktreePath, "provider-output.txt"),
            session === 1 ? "initial implementation\n" : "review addressed\n",
            "utf8"
          );
          await this.raw(accept, launch.runId, 0, {
            type: "system", subtype: "init", session_id: `claude-session-${session}`
          });
          await this.raw(accept, launch.runId, 1, {
            type: "assistant",
            message: { id: `claude-message-${session}`, content: [{ type: "text", text: "Claude completed the work" }] }
          });
          await this.raw(accept, launch.runId, 2, {
            type: "result", subtype: "success", session_id: `claude-session-${session}`, result: "Claude run complete"
          });
        } else {
          await this.raw(accept, launch.runId, 0, {
            type: "thread.started", thread_id: `codex-thread-${session}`
          });
          await this.raw(accept, launch.runId, 1, {
            type: "item.completed",
            item: { id: `codex-item-${session}`, type: "agent_message", text: "Codex review complete" }
          });
          await this.raw(accept, launch.runId, 2, {
            type: "turn.completed", usage: { input_tokens: 3, output_tokens: 2 }
          });
        }
      },
      cancel: async () => undefined
    };
  }

  private raw(
    accept: Parameters<RunnerPort["launch"]>[1],
    runId: string,
    providerSeq: number,
    payload: unknown
  ): Promise<void> {
    return accept({
      type: "provider.raw",
      runId,
      providerSeq,
      receivedAt: `2026-07-31T11:00:${String(this.session * 3 + providerSeq).padStart(2, "0")}.000Z`,
      payload
    });
  }
}

export async function createDualAgentProviderHarness() {
  let provider: TaskProviderPort | null = null;
  const context: { prepare?: Parameters<typeof createTaskEngineFixture>[0]["prepareContext"] } = {};
  const providerBridge: TaskProviderPort = {
    startRun: (request) => provider!.startRun(request),
    resumeRun: (request) => provider!.resumeRun(request),
    cancelRun: (runId, reason) => provider!.cancelRun(runId, reason)
  };
  const fixture = await createTaskEngineFixture({
    mockScript: [],
    providerOverride: providerBridge,
    prepareContext: (input) => context.prepare!(input)
  });
  context.prepare = createTaskRunContextPreparer({
    builder: new ContextBuilder(new RuntimeContextSource(fixture.databaseFixture.db, fixture.artifacts)),
    repository: new ContextRepository(fixture.repositories.providers, fixture.now),
    approvedScope(task) {
      if (!task.scopeApprovalId) throw new Error("TASK_SCOPE_APPROVAL_REQUIRED");
      return fixture.repositories.approvals.getRequired(task.scopeApprovalId).scope;
    }
  });
  const runner = new FakeSdkRunner();
  const healthList = async () => [
    health("claude", CLAUDE_CAPABILITIES),
    health("codex", CODEX_CAPABILITIES)
  ];
  const adapter = (providerId: ProviderId) => new RunnerBackedAdapter({
    provider: providerId,
    capabilities: providerId === "claude" ? CLAUDE_CAPABILITIES : CODEX_CAPABILITIES,
    health: { list: healthList },
    codexConfigLockRealpath: async () => "/private/tmp/subscription.config.lock.toml",
    runner,
    normalize: providerId === "claude" ? normalizeClaudeEvent : normalizeCodexEvent,
    now: fixture.now,
    repository: fixture.repositories.providers
  });
  provider = new RegistryTaskProvider(createProviderRegistry({
    policy: { claudeSubscription: { enabled: true }, codexSubscription: { enabled: true } },
    createClaudeAdapter: () => adapter("claude"),
    createCodexAdapter: () => adapter("codex")
  }));
  const collaboration = new CollaborationCoordinator({
    repositories: fixture.repositories,
    artifacts: fixture.artifacts,
    events: fixture.eventStore,
    manager: fixture.manager,
    engine: fixture.engine,
    workerGeneration: fixture.generation,
    contextVersion: 1,
    contextHash: `sha256:${"1".repeat(64)}`,
    id: fixture.id,
    now: fixture.now
  });
  const git = new GitCommandRunner();
  const candidates = new CandidateService({
    tasks: fixture.repositories.tasks,
    approvals: fixture.repositories.approvals,
    artifacts: fixture.artifacts,
    projects: fixture.repositories.projects,
    manager: fixture.manager,
    git,
    commands: new ApprovedCommandRunner({
      catalog: { get: () => null },
      processes: new JournaledProcessRunner({
        journal: fixture.repositories.operations,
        id: fixture.id,
        now: fixture.now
      }),
      id: fixture.id,
      now: fixture.now
    }),
    events: fixture.eventStore,
    id: fixture.id,
    now: fixture.now
  });

  return {
    fixture,
    runner,
    async runUntilCandidate() {
      await fixture.engine.startApprovedTask("task-1", "provider-lead");
      await collaboration.requestRound({ taskId: "task-1", purpose: "review", idempotencyKey: "provider-review-1" });
      await collaboration.completeReview({ taskId: "task-1", findings: ["address the review"], idempotencyKey: "provider-findings-1" });
      await fixture.engine.runLeadRevision({ taskId: "task-1", findings: ["address the review"], idempotencyKey: "provider-revision" });
      await collaboration.requestRound({ taskId: "task-1", purpose: "review", idempotencyKey: "provider-review-2" });
      await collaboration.completeReview({ taskId: "task-1", findings: [], idempotencyKey: "provider-findings-2" });
      const checkpoint = fixture.artifacts.listCheckpoints("task-1")
        .filter(({ worktreeId }) => worktreeId === fixture.artifacts.getWorktree("task-1", "lead")?.id)
        .at(-1);
      if (!checkpoint) throw new Error("LEAD_CHECKPOINT_REQUIRED");
      await candidates.buildVerifiedCandidate({
        taskId: "task-1",
        selectedCheckpointIds: [checkpoint.id],
        testCommandIds: [],
        unresolved: [],
        workerGeneration: fixture.generation,
        idempotencyKey: "provider-candidate"
      });
    },
    cleanup: fixture.cleanup
  };
}
