# Branchestra Git Task Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Milestone 2's durable `@Claude`/`@Codex` task workflow, capability approvals, mock-provider collaboration, isolated Git worktrees and checkpoints, immutable integration approvals, crash reconciliation, and Task Inspector without invoking either real Provider SDK or CLI.

**Architecture:** Extend Milestone 1's sole Electron utility-process worker, SQLite event store, versioned IPC, projects/rooms, and unified timeline; do not introduce another database owner or renderer-side privileged path. A deterministic task state machine coordinates narrow approval, provider, operation-journal, and Git ports, while `GitManager` is the only production object allowed to mutate Git and repository-scoped locks serialize structural changes. Every Git/process side effect follows `record intent -> execute idempotently or with compare-and-swap -> observe actual state -> mark complete`, so restart reconciliation can report rather than blindly replay uncertain work.

**Tech Stack:** Electron utility process, React, Vite, TypeScript, Zod, Node `DatabaseSync`/SQLite WAL, Node `execFile` with `shell: false`, Git worktrees/refs, Vitest, Testing Library, and Playwright Electron E2E.

## Global Constraints

- This plan starts after Milestone 1: `src/shared/contracts/{protocol,domain}.ts`, the utility-process worker, one SQLite connection/event store, `projects`, `rooms`, `room_events`, versioned request envelopes, snapshot/cursor replay, and the unified timeline already exist and pass `pnpm test:unit`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm typecheck`, and `pnpm build`.
- SQLite remains the canonical workflow/event source, but repository root/common-dir/ref/index/worktree facts are always re-observed from Git.
- The utility-process worker remains the sole SQLite/workflow/Git owner; Renderer, Preload, Main, and Provider implementations never open SQLite or mutate Git.
- Milestone 2 uses only `src/worker/providers/mock-provider.ts`; it must not import, install, detect, spawn, or simulate authentication for the Claude Agent SDK, `claude`, `@openai/codex-sdk`, or `codex`.
- Every production Git invocation uses `/usr/bin/git` through `execFile(executable, argv, { shell: false, ... })`, an argv array, a controlled environment, app-local identity, and `-c core.hooksPath=/dev/null`; no shell string is accepted at any layer.
- Provider code receives a worktree-scoped filesystem capability and read-only Git/context results, never `GitManager`, a SQLite handle, a shell callback, the Git common directory, or another Agent's writable root.
- Repository and worktree authorization compares canonical `realpath` values; `..`, symlink escapes, linked-worktree `.git` indirection, and the repository common directory are rejected before a write or child-process launch.
- A repository-scoped lock keyed by canonical Git common directory guards worktree add/remove, branch/ref mutation, checkpoint/integration commits, and final merge. Multiple tasks may otherwise run concurrently.
- Initial task approval permits at most two automatic Agent-to-Agent rounds. A human-directed revision does not increment that count; another round requires a new durable user receipt that explicitly increases the budget.
- `Completed`, `Cancelled`, and `Failed` are the only terminal task states. Every other state has explicit cancel, fail, and process-loss behavior covered by table-driven tests.
- Cancellation and failure stop dispatch and supervised work but never remove a worktree, branch, checkpoint ref, candidate ref, staged/unstaged content, or test log. Cleanup is outside this milestone.
- Checkpoints and candidates are full commit OIDs protected by create-only refs. A checkpoint/candidate ref is never moved; only a separately approved cleanup flow in a later milestone may delete it.
- A final merge receipt binds exactly `{ targetRef, baseOid, candidateOid, diffHash, testSetHash }`. Any mismatch invalidates the receipt and leaves or returns the task to `HumanApproval`.
- If the target ref is checked out, merge occurs only in its actual clean owner worktree with no in-progress Git operation and `git merge --ff-only`; Branchestra never stashes, resets, cleans, overwrites, or discards user changes. If the target is not checked out, merge uses `git update-ref <target> <candidateOid> <baseOid>` as an atomic CAS.
- An external ref race, uncertain journal observation, interrupted merge, or worker-generation mismatch never triggers automatic replay of a sensitive operation; it produces a structured recovery/approval event for the user.
- All task, approval, checkpoint, test, candidate, interrupt, reconciliation, and merge changes append structured room events through Milestone 1's `EventStore`; Provider prose cannot manufacture trusted approval actions.
- Each task below uses the existing pnpm lockfile and scripts. Do not add a dependency unless a shown implementation imports it.

---

## Milestone Boundary and Stable Milestone 1 Seams

Keep the Milestone 1 APIs below as the only foundation dependencies. If the foundation implementation has a differently named internal method, add a compatibility method at that boundary rather than teaching Milestone 2 about the internal name.

```ts
// src/worker/storage/database.ts (already present after Milestone 1)
export interface Database {
  transaction<T>(fn: () => T): T;
  prepare(sql: string): StatementSync;
  exec(sql: string): void;
  close(): void;
}

// src/worker/storage/event-store.ts (already present after Milestone 1)
export interface EventStore {
  append(input: AppendRoomEventInput): RoomEvent;
  snapshot(): AppSnapshot;
  after(cursor: RoomEventCursor): RoomEventPage;
}

// src/worker/protocol/command-handler.ts (already present after Milestone 1)
export interface CommandHandler<TType extends WorkerCommand['type']> {
  readonly type: TType;
  handle(
    command: Extract<WorkerCommand, { type: TType }>,
    context: CommandContext,
  ): Promise<HandlerResult> | HandlerResult;
}
```

Milestone 2 may extend `RoomEvent`, `AppSnapshot`, and `WorkerCommand`, and may add repositories to the existing migration/repository factory. It must not fork those contracts or add an alternate command bus, event store, or database connection.

## File Responsibility Map

| Area | Files | Responsibility |
|---|---|---|
| Shared contracts | `src/shared/contracts/domain.ts`, `src/shared/contracts/protocol.ts` | Exhaustive task states, receipts, candidates, Inspector view models, structured events, and versioned task commands. |
| Task workflow | `src/worker/tasks/task-state-machine.ts`, `task-repository.ts`, `task-service.ts`, `task-engine.ts`, `mention-parser.ts`, `provider-port.ts`, `recovery-coordinator.ts` | Pure transitions, durable task mutation, mention-to-task creation, mock run orchestration, rounds, cancellation, and recovery decisions. |
| Approvals | `src/worker/approvals/canonical-json.ts`, `approval-repository.ts`, `approval-service.ts`, `approved-workspace.ts`, `approved-command-runner.ts`, `final-approval-service.ts` | Stable hashes, capability receipts, scoped writes/commands, and immutable final merge tuple validation. |
| Operations | `src/worker/operations/operation-journal.ts`, `repository-lock.ts`, `journaled-process-runner.ts` | Durable intent/observation states, per-common-dir mutual exclusion, and supervised argv-only child execution. |
| Git | `src/worker/git/git-command-runner.ts`, `repository-inspector.ts`, `workspace-path-guard.ts`, `git-manager.ts`, `candidate-hasher.ts`, `merge-service.ts`, `git-operation-reconciler.ts` | All Git reads and the only Git mutations, canonical path safety, worktrees/checkpoints/candidates, hashes, CAS/ff-only integration, and observation after restart. |
| Mock Provider | `src/worker/providers/mock-provider.ts` | Deterministic async run/resume/cancel scripts implementing only the narrow task provider port. |
| Worker wiring | `src/worker/storage/migrations.ts`, `src/worker/storage/repositories.ts`, `src/worker/protocol/worker-router.ts`, `src/worker/runtime.ts` | Add schema/repositories/handlers and invoke reconciliation while retaining one worker owner. |
| Renderer | `src/renderer/features/tasks/use-task-inspector.ts`, `task-inspector.tsx`, `approval-panel.tsx`, `candidate-panel.tsx`, `recovery-panel.tsx` | Render trusted task state and invoke only typed task commands. |
| Tests | `tests/unit/**`, `tests/integration/**`, `tests/fixtures/**`, `e2e/**` | Exhaustive transition/security/hash tests, real temporary Git repositories, crash/race cases, and mock-provider Electron workflows. |

## State and Side-Effect Invariants

The implementation must encode, not merely document, this non-terminal system-transition table:

| Current state | `cancel` | `fail` | `processLoss` |
|---|---|---|---|
| `AwaitingApproval` | `Cancelled` | `Failed` | `Interrupted` |
| `Preparing` | `CancelRequested` | `Failed` | `Interrupted` |
| `Working` | `CancelRequested` | `Failed` | `Interrupted` |
| `Checkpoint` | `CancelRequested` | `Failed` | `Interrupted` |
| `Review1` | `CancelRequested` | `Failed` | `Interrupted` |
| `Revision` | `CancelRequested` | `Failed` | `Interrupted` |
| `Review2` | `CancelRequested` | `Failed` | `Interrupted` |
| `Candidate` | `CancelRequested` | `Failed` | `Interrupted` |
| `HumanApproval` | `CancelRequested` | `Failed` | `Interrupted` |
| `Merging` | `CancelRequested` | `Failed` | `Interrupted` |
| `CancelRequested` | `CancelRequested` | `Failed` | `Interrupted` |
| `Interrupted` | `Cancelled` | `Failed` | `Interrupted` |
| `Reconciling` | `Cancelled` | `Failed` | `Interrupted` |

Normal transitions are also closed: `AwaitingApproval -> Preparing`, `Preparing -> Working`, `Working -> Checkpoint|Candidate`, `Checkpoint -> Review1|Review2|Candidate`, `Review1 -> Revision`, `Revision -> Review2|Candidate`, `Review2 -> Candidate`, `Candidate -> HumanApproval`, `HumanApproval -> Merging|Revision`, `Merging -> Completed|HumanApproval`, `CancelRequested -> Cancelled`, `Interrupted -> Reconciling`, and `Reconciling -> recorded safe phase|Completed|HumanApproval|Cancelled`. No other state pair is accepted.

Every Git/process mutation must leave these durable journal observations:

```text
intent (expected external state + idempotency key)
  -> executing
  -> observed { outcome: not_applied | applied | conflict | uncertain, actual state }
  -> completed | needs_attention
```

An `intent` or `not_applied` record is not permission to replay after restart. The user first receives a recovery preview; only a new typed resume command may continue a non-sensitive step, while merge and external operations always require a currently valid receipt.

### Task 1: Exhaustive Task Domain Contracts and Pure Transition Table

**Files:**
- Modify: `src/shared/contracts/domain.ts`
- Modify: `src/shared/contracts/protocol.ts`
- Create: `src/worker/tasks/task-state-machine.ts`
- Test: `tests/unit/tasks/task-state-machine.test.ts`
- Test: `tests/unit/contracts/task-protocol.test.ts`

**Interfaces:**
- Consumes: Milestone 1 `Project`, `Room`, `RoomEvent`, `AppSnapshot`, `PROTOCOL_VERSION`, request envelopes, and Zod validation conventions.
- Produces: `TaskState`, `TaskRecord`, `TaskAction`, `TaskTransition`, `TaskCapabilityScope`, `ApprovalReceipt`, `FinalApprovalTuple`, `TaskInspectorModel`, task `RoomEvent` variants, task `WorkerCommand` variants, and `transitionTask(current, action): TaskTransition`.

- [ ] **Step 1: Write the failing exhaustive state-machine and protocol tests**

```ts
// tests/unit/tasks/task-state-machine.test.ts
import { describe, expect, it } from 'vitest';
import {
  NON_TERMINAL_TASK_STATES,
  transitionTask,
} from '../../../src/worker/tasks/task-state-machine';
import type { TaskRecord, TaskState } from '../../../src/shared/contracts/domain';

const expectedSystemTargets: Record<
  Exclude<TaskState, 'Completed' | 'Cancelled' | 'Failed'>,
  { cancel: TaskState; fail: TaskState; processLoss: TaskState }
> = {
  AwaitingApproval: { cancel: 'Cancelled', fail: 'Failed', processLoss: 'Interrupted' },
  Preparing: { cancel: 'CancelRequested', fail: 'Failed', processLoss: 'Interrupted' },
  Working: { cancel: 'CancelRequested', fail: 'Failed', processLoss: 'Interrupted' },
  Checkpoint: { cancel: 'CancelRequested', fail: 'Failed', processLoss: 'Interrupted' },
  Review1: { cancel: 'CancelRequested', fail: 'Failed', processLoss: 'Interrupted' },
  Revision: { cancel: 'CancelRequested', fail: 'Failed', processLoss: 'Interrupted' },
  Review2: { cancel: 'CancelRequested', fail: 'Failed', processLoss: 'Interrupted' },
  Candidate: { cancel: 'CancelRequested', fail: 'Failed', processLoss: 'Interrupted' },
  HumanApproval: { cancel: 'CancelRequested', fail: 'Failed', processLoss: 'Interrupted' },
  Merging: { cancel: 'CancelRequested', fail: 'Failed', processLoss: 'Interrupted' },
  CancelRequested: { cancel: 'CancelRequested', fail: 'Failed', processLoss: 'Interrupted' },
  Interrupted: { cancel: 'Cancelled', fail: 'Failed', processLoss: 'Interrupted' },
  Reconciling: { cancel: 'Cancelled', fail: 'Failed', processLoss: 'Interrupted' },
};

function task(state: TaskState, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1', roomId: 'room-1', projectId: 'project-1', requestEventId: 'event-1',
    requestText: '@Claude fix it', leadProvider: 'claude', targetRef: 'refs/heads/main',
    baseOid: 'a'.repeat(40), state, interruptedFromState: null, collaborationRoundsUsed: 0,
    collaborationRoundBudget: 2, humanRevisionCount: 0, revisionKind: null,
    scopeApprovalId: null, activeCandidateId: null, failure: null, version: 1,
    createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z',
    ...overrides,
  };
}

describe('transitionTask system transitions', () => {
  it('covers cancel, failure, and process loss for every non-terminal state', () => {
    expect([...NON_TERMINAL_TASK_STATES].sort()).toEqual(Object.keys(expectedSystemTargets).sort());
    for (const state of NON_TERMINAL_TASK_STATES) {
      expect(transitionTask(task(state), { type: 'cancel', reason: 'user' }).next.state)
        .toBe(expectedSystemTargets[state].cancel);
      expect(transitionTask(task(state), { type: 'fail', code: 'RUN_FAILED', message: 'boom' }).next.state)
        .toBe(expectedSystemTargets[state].fail);
      const interrupted = transitionTask(task(state), { type: 'processLoss', generation: '00000000-0000-4000-8000-000000000009' }).next;
      expect(interrupted.state).toBe(expectedSystemTargets[state].processLoss);
      expect(interrupted.interruptedFromState).toBe(state === 'Interrupted' ? null : state);
    }
  });

  it('enforces two automatic rounds and keeps human revisions out of the counter', () => {
    const first = transitionTask(task('Checkpoint'), { type: 'beginReview', checkpointOid: 'b'.repeat(40) }).next;
    expect(first).toMatchObject({ state: 'Review1', collaborationRoundsUsed: 1 });
    const second = transitionTask(task('Revision', { collaborationRoundsUsed: 1 }), {
      type: 'beginReview', checkpointOid: 'c'.repeat(40),
    }).next;
    expect(second).toMatchObject({ state: 'Review2', collaborationRoundsUsed: 2 });
    expect(() => transitionTask(task('Revision', { collaborationRoundsUsed: 2 }), {
      type: 'beginReview', checkpointOid: 'd'.repeat(40),
    })).toThrow('COLLABORATION_ROUND_BUDGET_EXHAUSTED');
    const human = transitionTask(task('HumanApproval', { collaborationRoundsUsed: 2 }), {
      type: 'requestHumanRevision', instruction: 'rename the command',
    }).next;
    expect(human).toMatchObject({ state: 'Revision', collaborationRoundsUsed: 2, humanRevisionCount: 1, revisionKind: 'human_directed' });
  });
});
```

```ts
// tests/unit/contracts/task-protocol.test.ts
import { describe, expect, it } from 'vitest';
import { RendererRequestEnvelopeSchema } from '../../../src/shared/contracts/protocol';

describe('task protocol', () => {
  it('accepts a typed final approval and rejects an incomplete tuple', () => {
    const base = { v: 1, requestId: '11111111-1111-4111-8111-111111111111', idempotencyKey: 'i1', workerGeneration: '00000000-0000-4000-8000-000000000004' };
    expect(RendererRequestEnvelopeSchema.safeParse({
      ...base, type: 'task.approveFinalMerge', payload: {
        taskId: 'task-1', approvalRequestId: 'approval-request-1', targetRef: 'refs/heads/main',
        baseOid: 'a'.repeat(40), candidateOid: 'b'.repeat(40),
        diffHash: 'sha256:diff', testSetHash: 'sha256:tests',
      },
    }).success).toBe(true);
    expect(RendererRequestEnvelopeSchema.safeParse({
      ...base, type: 'task.approveFinalMerge', payload: { taskId: 'task-1', approvalRequestId: 'approval-request-1' },
    }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the focused tests and verify the missing contracts fail**

Run: `pnpm test:unit -- tests/unit/tasks/task-state-machine.test.ts tests/unit/contracts/task-protocol.test.ts`

Expected: FAIL with module-resolution errors for `task-state-machine` and missing `TaskRecord`/`task.approveFinalMerge` contract members.

- [ ] **Step 3: Add exact domain and protocol types**

```ts
// Add to src/shared/contracts/domain.ts
export const TASK_STATES = [
  'AwaitingApproval', 'Preparing', 'Working', 'Checkpoint', 'Review1', 'Revision',
  'Review2', 'Candidate', 'HumanApproval', 'Merging', 'CancelRequested', 'Interrupted',
  'Reconciling', 'Completed', 'Cancelled', 'Failed',
] as const;
export type TaskState = typeof TASK_STATES[number];
export type AgentProvider = 'claude' | 'codex';
export type AgentRole = 'lead' | 'collaborator' | 'reviewer';
export type GitOid = string;

export interface TaskCapabilityScope {
  repositoryRootRealpath: string;
  gitCommonDirRealpath: string;
  writableRootsRealpath: string[];
  commandClasses: Array<'build' | 'test' | 'lint' | 'format'>;
  allowCollaborator: boolean;
  toolNetwork: boolean;
  maxRunMs: number;
  collaborationRoundBudget: number;
}

export interface FinalApprovalTuple {
  targetRef: string;
  baseOid: GitOid;
  candidateOid: GitOid;
  diffHash: `sha256:${string}`;
  testSetHash: `sha256:${string}`;
}

export interface ApprovalReceipt {
  id: string;
  requestId: string;
  taskId: string;
  kind: 'task_scope' | 'additional_round' | 'external_operation' | 'final_merge';
  decision: 'approved' | 'rejected';
  scope: TaskCapabilityScope | FinalApprovalTuple | { additionalRounds: number } | { operation: string };
  scopeHash: `sha256:${string}`;
  workerGeneration: string;
  survivesWorkerRestart: boolean;
  decidedAt: string;
}

export interface ApprovalRequest {
  id: string;
  taskId: string;
  kind: ApprovalReceipt['kind'];
  scope: ApprovalReceipt['scope'];
  scopeHash: `sha256:${string}`;
  requestedGeneration: string;
  status: 'pending' | 'decided';
  requestedAt: string;
}

export interface TaskRecord {
  id: string;
  roomId: string;
  projectId: string;
  requestEventId: string;
  requestText: string;
  leadProvider: AgentProvider;
  targetRef: string;
  baseOid: GitOid;
  state: TaskState;
  interruptedFromState: Exclude<TaskState, 'Completed' | 'Cancelled' | 'Failed'> | null;
  collaborationRoundsUsed: number;
  collaborationRoundBudget: number;
  humanRevisionCount: number;
  revisionKind: 'agent_review' | 'human_directed' | null;
  scopeApprovalId: string | null;
  activeCandidateId: string | null;
  failure: { code: string; message: string } | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type TaskAction =
  | { type: 'approveScope'; receiptId: string; collaborationRoundBudget: number }
  | { type: 'rejectScope'; receiptId: string }
  | { type: 'preparationSucceeded' }
  | { type: 'checkpointReady'; checkpointOid: GitOid }
  | { type: 'beginReview'; checkpointOid: GitOid }
  | { type: 'requestAgentRevision'; findings: string[] }
  | { type: 'candidateReady'; candidateId: string }
  | { type: 'requestHumanApproval' }
  | { type: 'approveMerge'; receiptId: string }
  | { type: 'requestHumanRevision'; instruction: string }
  | { type: 'grantAdditionalRounds'; receiptId: string; additionalRounds: number }
  | { type: 'mergeCompleted' }
  | { type: 'approvalInvalidated'; reason: string }
  | { type: 'cancel'; reason: 'user' | 'quit' | 'timeout' }
  | { type: 'cancelSettled' }
  | { type: 'fail'; code: string; message: string }
  | { type: 'processLoss'; generation: string }
  | { type: 'beginReconciliation' }
  | { type: 'resumeRecordedPhase'; target: TaskRecord['interruptedFromState'] | 'Completed' | 'HumanApproval' | 'Cancelled' };

export interface TaskTransition {
  previous: TaskRecord;
  next: TaskRecord;
  event: { type: `task.${string}`; payload: Record<string, unknown> };
}

export interface TaskInspectorModel {
  task: TaskRecord;
  scopeReceipt: ApprovalReceipt | null;
  activeRuns: AgentRunRecord[];
  worktrees: WorktreeRecord[];
  checkpoints: CheckpointRecord[];
  candidate: IntegrationCandidate | null;
  pendingApproval: ApprovalRequest | null;
  recovery: RecoveryPreview | null;
}
```

Add these exact shared records before extending `RoomEvent`; do not represent their payloads as `unknown`:

```ts
export interface AgentRunRecord {
  id: string; taskId: string; provider: AgentProvider; role: AgentRole;
  providerSessionId: string | null; contextVersion: number; contextHash: `sha256:${string}`;
  state: 'starting' | 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
  startedAt: string; finishedAt: string | null;
}
export interface WorktreeRecord {
  id: string; taskId: string; role: 'lead' | 'collaborator'; pathRealpath: string;
  branchRef: string; baseOid: GitOid; currentCheckpointOid: GitOid | null;
  retained: true; createdAt: string;
}
export interface CheckpointRecord {
  id: string; taskId: string; worktreeId: string; authorProvider: AgentProvider;
  purpose: 'implementation' | 'review' | 'revision' | 'candidate'; oid: GitOid;
  immutableRef: string; createdAt: string;
}
export interface TestResultRecord {
  id: string; taskId: string; candidateId: string; commandId: string;
  executableRealpath: string; argv: string[]; exitCode: number;
  stdoutHash: `sha256:${string}`; stderrHash: `sha256:${string}`;
  durationMs: number; logReference: string; createdAt: string;
}
export interface IntegrationCandidate {
  id: string; taskId: string; leadWorktreeId: string; targetRef: string;
  baseOid: GitOid; candidateOid: GitOid; immutableRef: string;
  diffHash: `sha256:${string}`; testSetHash: `sha256:${string}`;
  diffSummary: { filesChanged: number; additions: number; deletions: number; files: GitDiffFileSummary[] };
  selectedCheckpointIds: string[]; testResults: TestResultRecord[];
  unresolved: Array<{ source: AgentProvider | 'git' | 'test'; summary: string }>;
  verificationStatus: 'passed' | 'failed'; createdAt: string;
}
export interface RecoveryOperationPreview {
  operationId: string; operationType: string;
  outcome: 'not_applied' | 'applied' | 'conflict' | 'uncertain';
  expected: Record<string, unknown>; actual: Record<string, unknown>;
}
export interface RecoveryPreview {
  taskId: string; recordedPhase: TaskRecord['interruptedFromState'];
  repositoryAvailable: boolean; worktrees: WorktreeRecord[]; checkpoints: CheckpointRecord[];
  dirtyPaths: string[]; providerSessionResumable: boolean;
  operations: RecoveryOperationPreview[]; previewHash: `sha256:${string}`; createdAt: string;
}
export interface GitDiffFileSummary {
  path: string; status: string; additions: number; deletions: number;
}
export type TaskProviderEventSummary =
  | { type: 'assistant.message'; text: string }
  | { type: 'workspace.writeText'; relativePath: string; contentHash: `sha256:${string}` }
  | { type: 'test.request'; commandId: string }
  | { type: 'collaborator.request'; purpose: 'parallel_implementation' | 'review' }
  | { type: 'review.findings'; checkpointOid: string; findings: string[] }
  | { type: 'run.completed'; summary: string }
  | { type: 'run.failed'; code: string; message: string };
```

Extend `RoomEvent` with exact discriminated variants whose payloads are: `task.created { task: TaskRecord }`, `task.transitioned { taskId, from, to, version }`, `approval.requested { request: ApprovalRequest }`, `approval.decided { receipt: ApprovalReceipt }`, `agent.run { run: AgentRunRecord, event: TaskProviderEventSummary }`, `checkpoint.created { checkpoint: CheckpointRecord }`, `test.completed { result: TestResultRecord }`, `candidate.created { candidate: IntegrationCandidate }`, `task.interrupted { taskId, from, workerGeneration }`, `task.recovery { preview: RecoveryPreview }`, and `merge.completed { taskId, targetRef, previousOid, targetOid, mode }`. The shared summary must never contain raw process handles, file contents, or SDK types.

Add Zod branches and the following exact command union; OIDs must match `/^[0-9a-f]{40,64}$/`, refs must match `/^refs\/heads\/[A-Za-z0-9._\/-]+$/`, counts are non-negative integers, and `additionalRounds` is an integer from 1 through 2.

```ts
export type TaskWorkerCommand =
  | { type: 'task.get'; payload: { taskId: string } }
  | { type: 'task.approveScope'; payload: { taskId: string; approvalRequestId: string; decision: 'approved' | 'rejected'; displayedScopeHash: string } }
  | { type: 'task.cancel'; payload: { taskId: string; reason: 'user' | 'quit' | 'timeout' } }
  | { type: 'task.requestRevision'; payload: { taskId: string; instruction: string } }
  | { type: 'task.grantAdditionalRound'; payload: { taskId: string; approvalRequestId: string; additionalRounds: 1 | 2; displayedScopeHash: string } }
  | ({ type: 'task.approveFinalMerge'; payload: { taskId: string; approvalRequestId: string } & FinalApprovalTuple })
  | { type: 'task.recovery.preview'; payload: { taskId: string } }
  | { type: 'task.recovery.resolve'; payload: { taskId: string; previewHash: string; decision: 'resume_recorded_phase' | 'keep_observed_state' | 'cancel_and_retain'; selectedOperationIds: string[] } };
```

- [ ] **Step 4: Implement the closed transition function**

```ts
// src/worker/tasks/task-state-machine.ts
import type { TaskAction, TaskRecord, TaskState, TaskTransition } from '../../shared/contracts/domain';

export const NON_TERMINAL_TASK_STATES = [
  'AwaitingApproval', 'Preparing', 'Working', 'Checkpoint', 'Review1', 'Revision',
  'Review2', 'Candidate', 'HumanApproval', 'Merging', 'CancelRequested',
  'Interrupted', 'Reconciling',
] as const satisfies readonly TaskState[];

const activeCancellationStates = new Set<TaskState>([
  'Preparing', 'Working', 'Checkpoint', 'Review1', 'Revision', 'Review2',
  'Candidate', 'HumanApproval', 'Merging', 'CancelRequested',
]);

function moved(current: TaskRecord, patch: Partial<TaskRecord>, event: TaskTransition['event']): TaskTransition {
  return {
    previous: current,
    next: { ...current, ...patch, version: current.version + 1 },
    event,
  };
}

export function transitionTask(current: TaskRecord, action: TaskAction): TaskTransition {
  if (['Completed', 'Cancelled', 'Failed'].includes(current.state)) {
    throw new Error(`TERMINAL_TASK:${current.state}`);
  }
  if (action.type === 'fail') {
    return moved(current, { state: 'Failed', failure: { code: action.code, message: action.message } },
      { type: 'task.failed', payload: { code: action.code, message: action.message } });
  }
  if (action.type === 'processLoss') {
    return moved(current, {
      state: 'Interrupted',
      interruptedFromState: current.state === 'Interrupted' ? current.interruptedFromState : current.state,
    }, { type: 'task.interrupted', payload: { generation: action.generation, from: current.state } });
  }
  if (action.type === 'cancel') {
    const state = activeCancellationStates.has(current.state) ? 'CancelRequested' : 'Cancelled';
    return moved(current, { state }, { type: 'task.cancelled', payload: { reason: action.reason, pending: state === 'CancelRequested' } });
  }
  if (action.type === 'beginReview') {
    if (!['Checkpoint', 'Revision'].includes(current.state)) throw new Error(`ILLEGAL_TRANSITION:${current.state}:beginReview`);
    if (current.collaborationRoundsUsed >= current.collaborationRoundBudget) throw new Error('COLLABORATION_ROUND_BUDGET_EXHAUSTED');
    const round = current.collaborationRoundsUsed + 1;
    return moved(current, { state: round === 1 ? 'Review1' : 'Review2', collaborationRoundsUsed: round, revisionKind: null },
      { type: 'task.reviewStarted', payload: { round, checkpointOid: action.checkpointOid } });
  }
  if (action.type === 'requestHumanRevision' && current.state === 'HumanApproval') {
    return moved(current, { state: 'Revision', humanRevisionCount: current.humanRevisionCount + 1, revisionKind: 'human_directed' },
      { type: 'task.revisionRequested', payload: { source: 'human', instruction: action.instruction } });
  }
  if (action.type === 'grantAdditionalRounds' && ['HumanApproval', 'Revision'].includes(current.state)) {
    return moved(current, { collaborationRoundBudget: current.collaborationRoundBudget + action.additionalRounds },
      { type: 'task.roundBudgetGranted', payload: { receiptId: action.receiptId, additionalRounds: action.additionalRounds } });
  }

  const key = `${current.state}:${action.type}`;
  switch (key) {
    case 'AwaitingApproval:approveScope': return moved(current, { state: 'Preparing', scopeApprovalId: (action as Extract<TaskAction, { type: 'approveScope' }>).receiptId, collaborationRoundBudget: (action as Extract<TaskAction, { type: 'approveScope' }>).collaborationRoundBudget }, { type: 'task.scopeApproved', payload: {} });
    case 'AwaitingApproval:rejectScope': return moved(current, { state: 'Cancelled' }, { type: 'task.scopeRejected', payload: {} });
    case 'Preparing:preparationSucceeded': return moved(current, { state: 'Working' }, { type: 'task.prepared', payload: {} });
    case 'Working:checkpointReady': return moved(current, { state: 'Checkpoint' }, { type: 'task.checkpointReady', payload: {} });
    case 'Working:candidateReady':
    case 'Checkpoint:candidateReady':
    case 'Revision:candidateReady':
    case 'Review2:candidateReady': return moved(current, { state: 'Candidate', activeCandidateId: (action as Extract<TaskAction, { type: 'candidateReady' }>).candidateId }, { type: 'task.candidateReady', payload: {} });
    case 'Review1:requestAgentRevision': return moved(current, { state: 'Revision', revisionKind: 'agent_review' }, { type: 'task.revisionRequested', payload: { source: 'reviewer' } });
    case 'Candidate:requestHumanApproval': return moved(current, { state: 'HumanApproval' }, { type: 'task.humanApprovalRequested', payload: {} });
    case 'HumanApproval:approveMerge': return moved(current, { state: 'Merging' }, { type: 'task.mergeApproved', payload: {} });
    case 'Merging:mergeCompleted': return moved(current, { state: 'Completed' }, { type: 'task.completed', payload: {} });
    case 'HumanApproval:approvalInvalidated':
    case 'Merging:approvalInvalidated': return moved(current, { state: 'HumanApproval' }, { type: 'task.approvalInvalidated', payload: { reason: (action as Extract<TaskAction, { type: 'approvalInvalidated' }>).reason } });
    case 'CancelRequested:cancelSettled': return moved(current, { state: 'Cancelled' }, { type: 'task.cancelled', payload: { pending: false } });
    case 'Interrupted:beginReconciliation': return moved(current, { state: 'Reconciling' }, { type: 'task.reconciling', payload: {} });
    case 'Reconciling:resumeRecordedPhase': return moved(current, { state: (action as Extract<TaskAction, { type: 'resumeRecordedPhase' }>).target ?? 'HumanApproval', interruptedFromState: null }, { type: 'task.recovered', payload: { target: (action as Extract<TaskAction, { type: 'resumeRecordedPhase' }>).target } });
    default: throw new Error(`ILLEGAL_TRANSITION:${key}`);
  }
}
```

Add table tests for every normal transition listed under “State and Side-Effect Invariants,” terminal-state rejection, `Review2` reuse only after an explicit additional-round receipt, and `Reconciling` refusing a target different from the persisted `interruptedFromState` except the reconciler's explicit `Completed`, `HumanApproval`, or `Cancelled` resolution.

- [ ] **Step 5: Run unit tests and type checking**

Run: `pnpm test:unit -- tests/unit/tasks/task-state-machine.test.ts tests/unit/contracts/task-protocol.test.ts && pnpm typecheck`

Expected: both test files PASS, the exhaustive `Record` fails compilation if a future non-terminal state lacks system transitions, and TypeScript reports no errors.

- [ ] **Step 6: Commit the task contracts and state machine**

```bash
git add src/shared/contracts/domain.ts src/shared/contracts/protocol.ts src/worker/tasks/task-state-machine.ts tests/unit/tasks/task-state-machine.test.ts tests/unit/contracts/task-protocol.test.ts
git commit -m "feat(tasks): define exhaustive task state machine"
```

### Task 2: Durable Task, Approval, Run, Worktree, Candidate, and Journal Storage

**Files:**
- Modify: `src/worker/storage/migrations.ts`
- Modify: `src/worker/storage/repositories.ts`
- Create: `src/worker/tasks/task-repository.ts`
- Create: `src/worker/approvals/approval-repository.ts`
- Create: `src/worker/operations/operation-journal.ts`
- Modify: `tests/fixtures/test-database.ts`
- Test: `tests/integration/storage/task-engine-schema.test.ts`
- Test: `tests/unit/tasks/task-repository.test.ts`

**Interfaces:**
- Consumes: Milestone 1 `Database.transaction/prepare/exec`, `EventStore.append`, existing `projects(id)`, `rooms(id, project_id)`, and ISO timestamp/ID factories injected by the caller.
- Produces: `TaskRepository`, `ApprovalRepository`, `OperationJournal`, the migration named `002_task_engine`, and `DomainRepositories.tasks/approvals/operations` from the existing repository factory.

- [ ] **Step 1: Write failing schema durability and optimistic-version tests**

```ts
// tests/integration/storage/task-engine-schema.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { openTestDatabase } from '../../fixtures/test-database';
import { createRepositories } from '../../../src/worker/storage/repositories';

describe('task engine schema', () => {
  const opened: Array<{ close(): void }> = [];
  afterEach(() => opened.splice(0).forEach((db) => db.close()));

  it('persists all recovery inputs across a database reopen', () => {
    const first = openTestDatabase(); opened.push(first.db);
    const repositories = createRepositories(first.db);
    repositories.tasks.insert(first.records.task);
    repositories.approvals.insertRequest(first.records.scopeApprovalRequest);
    repositories.approvals.decideRequest('scope-request-1', first.records.scopeApproval);
    repositories.operations.recordIntent(first.records.operationIntent);
    first.db.close(); opened.pop();

    const second = openTestDatabase(first.path); opened.push(second.db);
    const reopened = createRepositories(second.db);
    expect(reopened.tasks.getRequired('task-1')).toMatchObject({ state: 'AwaitingApproval', baseOid: 'a'.repeat(40) });
    expect(reopened.approvals.getRequired('approval-1').scopeHash).toBe('sha256:scope');
    expect(reopened.operations.listIncomplete('project-1')).toHaveLength(1);
  });

  it('rejects a stale task version', () => {
    const fixture = openTestDatabase(); opened.push(fixture.db);
    const tasks = createRepositories(fixture.db).tasks;
    tasks.insert(fixture.records.task);
    tasks.updateState({ ...fixture.records.task, state: 'Preparing', version: 2 }, 1);
    expect(() => tasks.updateState({ ...fixture.records.task, state: 'Working', version: 3 }, 1))
      .toThrow('TASK_VERSION_CONFLICT:task-1');
  });
});
```

- [ ] **Step 2: Run the storage test and verify the new repositories are absent**

Run: `pnpm test:integration -- tests/integration/storage/task-engine-schema.test.ts`

Expected: FAIL because `DomainRepositories` has no `tasks`, `approvals`, or `operations` repository and migration `002_task_engine` has not created the tables.

- [ ] **Step 3: Add the complete migration in the existing migration registry**

```ts
// Add as one migration entry in src/worker/storage/migrations.ts
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
`;
```

Register it as schema version `2` in the same transaction and preserve Milestone 1 WAL/foreign-key setup. Add a migration-reopen test that proves applying migrations twice is a no-op.

- [ ] **Step 4: Implement exact repository surfaces and atomic task transition persistence**

```ts
// src/worker/tasks/task-repository.ts
import type { TaskRecord, TaskTransition } from '../../shared/contracts/domain';
import type { Database } from '../storage/database';
import type { EventStore } from '../storage/event-store';

export class TaskRepository {
  constructor(private readonly db: Database, private readonly events: EventStore) {}

  insert(task: TaskRecord): void;
  get(taskId: string): TaskRecord | null;
  getRequired(taskId: string): TaskRecord;
  listNonTerminal(): TaskRecord[];
  updateState(next: TaskRecord, expectedVersion: number): void;
  applyTransition(transition: TaskTransition, idempotencyKey: string): TaskRecord;
  insertRun(run: AgentRunRecord): void;
  getRun(runId: string): AgentRunRecord | null;
  listRuns(taskId: string): AgentRunRecord[];
  updateRunState(runId: string, state: AgentRunRecord['state'], finishedAt: string | null): void;
}
```

`updateState` must execute one `UPDATE tasks ... WHERE id = ? AND version = ?`; if `changes !== 1`, throw `TASK_VERSION_CONFLICT:<id>`. `applyTransition` must call `db.transaction`, update the row with the previous version, then call `events.append({ id, roomId, type, actor, payload, createdAt })` before commit. The actor is selected from trusted transition data (`system` for workflow/approval/Git state, or the exact Provider ID for normalized Agent output), never from Provider prose. Map every SQL column explicitly; do not persist a `TaskRecord` as one opaque JSON blob.

```ts
// src/worker/approvals/approval-repository.ts
export class ApprovalRepository {
  constructor(private readonly db: Database) {}
  insertRequest(request: ApprovalRequest): void;
  getRequest(requestId: string): ApprovalRequest | null;
  getPendingRequest(taskId: string): ApprovalRequest | null;
  decideRequest(requestId: string, receipt: ApprovalReceipt): void;
  insert(receipt: ApprovalReceipt): void;
  get(approvalId: string): ApprovalReceipt | null;
  getRequired(approvalId: string): ApprovalReceipt;
  findApproved(taskId: string, kind: ApprovalReceipt['kind'], scopeHash: string): ApprovalReceipt | null;
  listForTask(taskId: string): ApprovalReceipt[];
  invalidateSensitiveFromOlderGeneration(currentGeneration: string): string[];
}

// src/worker/operations/operation-journal.ts
export type OperationStatus = 'intent' | 'executing' | 'observed' | 'completed' | 'needs_attention';
export interface OperationRecord<E = Record<string, unknown>, O = Record<string, unknown>> {
  id: string; projectId: string; taskId: string | null; repositoryCommonDirRealpath: string;
  operationType: string; idempotencyKey: string; expected: E; status: OperationStatus;
  observation: O | null; workerGeneration: string; createdAt: string; updatedAt: string;
}
export interface RecordIntentResult<E> { record: OperationRecord<E, never>; created: boolean }
export class OperationJournal {
  constructor(private readonly db: Database) {}
  recordIntent<E>(record: OperationRecord<E, never>): RecordIntentResult<E>;
  markExecuting(id: string): void;
  recordObservation<O>(id: string, observation: O): void;
  complete(id: string): void;
  needsAttention(id: string, observation: Record<string, unknown>): void;
  getByIdempotencyKey(key: string): OperationRecord | null;
  listIncomplete(projectId?: string): OperationRecord[];
}
```

`recordIntent` returns `{ record, created: true }` for a new row and `{ record, created: false }` when the idempotency key and canonical `expected_json` match an existing row; it throws `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INTENT` when they differ. `complete` is legal only after `observed`; `needsAttention` is legal from any non-completed state and never deletes a record.

- [ ] **Step 5: Wire the repositories into the existing factory and pass storage tests**

Run: `pnpm test:unit -- tests/unit/tasks/task-repository.test.ts && pnpm test:integration -- tests/integration/storage/task-engine-schema.test.ts && pnpm typecheck`

Expected: all focused tests PASS; a database reopen returns the same task/approval/operation; stale versions and checkpoint OID updates are rejected.

- [ ] **Step 6: Commit the durable schema and repositories**

```bash
git add src/worker/storage/migrations.ts src/worker/storage/repositories.ts src/worker/tasks/task-repository.ts src/worker/approvals/approval-repository.ts src/worker/operations/operation-journal.ts tests/fixtures/test-database.ts tests/integration/storage/task-engine-schema.test.ts tests/unit/tasks/task-repository.test.ts
git commit -m "feat(tasks): persist workflow and operation state"
```

### Task 3: Journaled Operation Coordinator and Repository-Scoped Lock

**Files:**
- Create: `src/worker/operations/journaled-operation-runner.ts`
- Create: `src/worker/operations/repository-lock.ts`
- Test: `tests/unit/operations/journaled-operation-runner.test.ts`
- Test: `tests/unit/operations/repository-lock.test.ts`

**Interfaces:**
- Consumes: `OperationJournal.recordIntent/markExecuting/recordObservation/complete/needsAttention` from Task 2.
- Produces: `JournaledOperationRunner.run<E, O, R>(spec): Promise<R>`, `OperationObservation<O, R>`, and `RepositoryLock.withLock<T>(commonDirRealpath, operation): Promise<T>` used by every later Git/process mutation.

- [ ] **Step 1: Write failing tests for the four side-effect boundaries and lock scope**

```ts
// tests/unit/operations/journaled-operation-runner.test.ts
import { describe, expect, it, vi } from 'vitest';
import { JournaledOperationRunner } from '../../../src/worker/operations/journaled-operation-runner';

describe('JournaledOperationRunner', () => {
  it('records intent before execute and completes only after an applied observation', async () => {
    const calls: string[] = [];
    const journal = {
      recordIntent: vi.fn((record) => (calls.push('intent'), { record, created: true })),
      markExecuting: vi.fn(() => calls.push('executing')),
      recordObservation: vi.fn(() => calls.push('observed')),
      complete: vi.fn(() => calls.push('completed')),
      needsAttention: vi.fn(() => calls.push('needs_attention')),
    };
    const result = await new JournaledOperationRunner(journal).run({
      intent: operationIntent('op-1'),
      execute: async () => { calls.push('execute'); },
      observe: async () => ({ outcome: 'applied', actual: { oid: 'b'.repeat(40) }, result: 'ok' }),
    });
    expect(result).toBe('ok');
    expect(calls).toEqual(['intent', 'executing', 'execute', 'observed', 'completed']);
  });

  it.each(['conflict', 'uncertain'] as const)('marks %s observations for attention', async (outcome) => {
    const journal = inMemoryOperationJournal();
    await expect(new JournaledOperationRunner(journal).run({
      intent: operationIntent(`op-${outcome}`), execute: async () => undefined,
      observe: async () => ({ outcome, actual: { ref: 'changed externally' } }),
    })).rejects.toThrow(`OPERATION_${outcome.toUpperCase()}`);
    expect(journal.getByIdempotencyKey(`idem-op-${outcome}`)?.status).toBe('needs_attention');
  });
});
```

```ts
// tests/unit/operations/repository-lock.test.ts
import { describe, expect, it } from 'vitest';
import { RepositoryLock } from '../../../src/worker/operations/repository-lock';

describe('RepositoryLock', () => {
  it('serializes the same canonical common dir and allows distinct repositories', async () => {
    const lock = new RepositoryLock();
    const timeline: string[] = [];
    const gate = Promise.withResolvers<void>();
    const first = lock.withLock('/repo/.git', async () => { timeline.push('a:start'); await gate.promise; timeline.push('a:end'); });
    const second = lock.withLock('/repo/.git', async () => { timeline.push('b:start'); timeline.push('b:end'); });
    const other = lock.withLock('/other/.git', async () => { timeline.push('c:start'); timeline.push('c:end'); });
    await other;
    expect(timeline).toEqual(['a:start', 'c:start', 'c:end']);
    gate.resolve();
    await Promise.all([first, second]);
    expect(timeline).toEqual(['a:start', 'c:start', 'c:end', 'a:end', 'b:start', 'b:end']);
  });
});
```

The test helpers `operationIntent` and `inMemoryOperationJournal` must be complete typed fixtures in the same test file; their methods must model the status preconditions from Task 2 rather than returning unconditional stubs.

- [ ] **Step 2: Run the operation tests and verify both modules are missing**

Run: `pnpm test:unit -- tests/unit/operations/journaled-operation-runner.test.ts tests/unit/operations/repository-lock.test.ts`

Expected: FAIL with module-resolution errors for `journaled-operation-runner` and `repository-lock`.

- [ ] **Step 3: Implement the journaled coordinator with explicit observations**

```ts
// src/worker/operations/journaled-operation-runner.ts
import type { OperationJournal, OperationRecord } from './operation-journal';

export type OperationObservation<O, R> =
  | { outcome: 'applied'; actual: O; result: R }
  | { outcome: 'not_applied'; actual: O }
  | { outcome: 'conflict'; actual: O }
  | { outcome: 'uncertain'; actual: O };

export interface JournaledOperationSpec<E, O, R> {
  intent: OperationRecord<E, never>;
  execute(): Promise<void>;
  observe(): Promise<OperationObservation<O, R>>;
}

export class JournaledOperationRunner {
  constructor(private readonly journal: Pick<OperationJournal,
    'recordIntent' | 'markExecuting' | 'recordObservation' | 'complete' | 'needsAttention'>) {}

  async run<E, O extends Record<string, unknown>, R>(spec: JournaledOperationSpec<E, O, R>): Promise<R> {
    const intentResult = this.journal.recordIntent(spec.intent);
    const durable = intentResult.record;
    if (!intentResult.created && durable.status === 'completed' && durable.observation) {
      const prior = durable.observation as { outcome: string; result?: R };
      if (prior.outcome === 'applied' && 'result' in prior) return prior.result as R;
    }
    if (!intentResult.created) throw new Error(`OPERATION_REQUIRES_RECONCILIATION:${durable.id}`);
    this.journal.markExecuting(durable.id);
    await spec.execute();
    const observed = await spec.observe();
    this.journal.recordObservation(durable.id, observed);
    if (observed.outcome === 'applied') {
      this.journal.complete(durable.id);
      return observed.result;
    }
    this.journal.needsAttention(durable.id, observed);
    throw new Error(`OPERATION_${observed.outcome.toUpperCase()}:${durable.id}`);
  }
}
```

Do not automatically execute an existing `intent`, `executing`, `observed`, or `needs_attention` record in this method. The only replay optimization above is returning an already `completed` record whose canonical intent matches; startup handling of every other state belongs to Task 12.

- [ ] **Step 4: Implement a fair FIFO lock keyed by a pre-canonicalized common dir**

```ts
// src/worker/operations/repository-lock.ts
export class RepositoryLock {
  private readonly tails = new Map<string, Promise<void>>();

  async withLock<T>(commonDirRealpath: string, operation: () => Promise<T>): Promise<T> {
    if (!commonDirRealpath.startsWith('/')) throw new Error('REPOSITORY_LOCK_KEY_NOT_ABSOLUTE');
    const previous = this.tails.get(commonDirRealpath) ?? Promise.resolve();
    const release = Promise.withResolvers<void>();
    const tail = previous.then(() => release.promise);
    this.tails.set(commonDirRealpath, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release.resolve();
      if (this.tails.get(commonDirRealpath) === tail) this.tails.delete(commonDirRealpath);
    }
  }
}
```

The lock does not claim to exclude an external terminal Git process; later operations must still use ref expectations/CAS and re-observation.

- [ ] **Step 5: Run operation tests and the full unit suite**

Run: `pnpm test:unit -- tests/unit/operations/journaled-operation-runner.test.ts tests/unit/operations/repository-lock.test.ts && pnpm test:unit`

Expected: focused tests and the complete unit suite PASS; call order proves no side effect precedes durable intent.

- [ ] **Step 6: Commit the operation coordinator and repository lock**

```bash
git add src/worker/operations/journaled-operation-runner.ts src/worker/operations/repository-lock.ts tests/unit/operations/journaled-operation-runner.test.ts tests/unit/operations/repository-lock.test.ts
git commit -m "feat(operations): journal side effects and lock repositories"
```

### Task 4: Safe Git Execution, Repository Identity, Read-Only Queries, and Path Guards

**Files:**
- Create: `src/worker/git/git-command-runner.ts`
- Create: `src/worker/git/repository-inspector.ts`
- Create: `src/worker/git/workspace-path-guard.ts`
- Create: `tests/fixtures/git-repository.ts`
- Test: `tests/unit/git/workspace-path-guard.test.ts`
- Test: `tests/integration/git/repository-inspector.test.ts`
- Test: `tests/unit/git/git-command-runner.test.ts`

**Interfaces:**
- Consumes: Node `execFile`, `fs.promises.realpath/lstat`, `/usr/bin/git`, and absolute paths supplied by the worker; no approval or mutation API yet.
- Produces: `GitCommandRunner.run/runBuffer`, `GitReadService.inspectRepository/status/diff/show/log/listWorktrees`, `RepositoryIdentity`, `GitWorktreeOwner`, `WorkspacePathGuard.create/resolveReadable/resolveWritable/assertChildCwd`, and a real temporary-repository fixture used by every later Git integration test.

- [ ] **Step 1: Write failing negative path tests and an argv-only runner test**

```ts
// tests/unit/git/workspace-path-guard.test.ts
import { describe, expect, it } from 'vitest';
import { WorkspacePathGuard } from '../../../src/worker/git/workspace-path-guard';
import { makePathGuardFixture } from '../../fixtures/git-repository';

describe('WorkspacePathGuard', () => {
  it.each([
    ['traversal', '../outside.txt'],
    ['absolute outside path', '/private/tmp/outside.txt'],
    ['linked-worktree metadata', '.git'],
    ['common directory', '__COMMON_DIR__'],
    ['external symlink leaf', 'external-link/secret.txt'],
    ['external symlink parent for a new file', 'external-link/new.txt'],
  ])('rejects %s', async (_label, input) => {
    const fixture = await makePathGuardFixture();
    const candidate = input === '__COMMON_DIR__' ? fixture.commonDirRealpath : input;
    const guard = await WorkspacePathGuard.create(fixture.identity);
    await expect(guard.resolveWritable(candidate)).rejects.toThrow(/PATH_(ESCAPES_WORKTREE|IS_GIT_METADATA)/);
  });
});
```

```ts
// tests/unit/git/git-command-runner.test.ts
import { expect, it, vi } from 'vitest';
import { GitCommandRunner } from '../../../src/worker/git/git-command-runner';

it('always uses execFile argv, shell false, controlled env, app identity, and disabled hooks', async () => {
  const execFile = vi.fn((_file, _argv, _options, callback) => callback(null, { stdout: 'abc\n', stderr: '' }));
  const runner = new GitCommandRunner({ execFile, executableRealpath: '/usr/bin/git' });
  await runner.run('/repo', ['rev-parse', 'HEAD']);
  expect(execFile).toHaveBeenCalledWith('/usr/bin/git', [
    '-c', 'user.name=Branchestra', '-c', 'user.email=branchestra@localhost',
    '-c', 'core.hooksPath=/dev/null', '-C', '/repo', 'rev-parse', 'HEAD',
  ], expect.objectContaining({
    shell: false,
    env: {
      PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    },
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }), expect.any(Function));
});
```

- [ ] **Step 2: Run focused tests and verify the Git safety modules are absent**

Run: `pnpm test:unit -- tests/unit/git/workspace-path-guard.test.ts tests/unit/git/git-command-runner.test.ts`

Expected: FAIL because `GitCommandRunner`, `WorkspacePathGuard`, and the Git fixture do not exist.

- [ ] **Step 3: Implement the sole low-level Git executor**

```ts
// src/worker/git/git-command-runner.ts
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface GitCommandResult { stdout: string; stderr: string }
export interface GitCommandRunnerOptions {
  executableRealpath?: '/usr/bin/git';
  execFile?: typeof nodeExecFile;
}

const gitArgPrefix = [
  '-c', 'user.name=Branchestra',
  '-c', 'user.email=branchestra@localhost',
  '-c', 'core.hooksPath=/dev/null',
] as const;
const gitEnvironment = Object.freeze({
  PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
});

export class GitCommandRunner {
  private readonly executable: string;
  private readonly execute: ReturnType<typeof promisify<typeof nodeExecFile>>;
  constructor(options: GitCommandRunnerOptions = {}) {
    this.executable = options.executableRealpath ?? '/usr/bin/git';
    this.execute = promisify(options.execFile ?? nodeExecFile);
  }
  async run(cwdRealpath: string, argv: readonly string[]): Promise<GitCommandResult> {
    const result = await this.execute(this.executable, [...gitArgPrefix, '-C', cwdRealpath, ...argv], {
      shell: false, env: gitEnvironment, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  }
  async runBuffer(cwdRealpath: string, argv: readonly string[]): Promise<Buffer> {
    const result = await this.execute(this.executable, [...gitArgPrefix, '-C', cwdRealpath, ...argv], {
      shell: false, env: gitEnvironment, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
    });
    return result.stdout;
  }
}
```

Do not export `execute`, the environment, or a generic command method. Tests may inject `execFile`; production construction fixes the executable to `/usr/bin/git`.

- [ ] **Step 4: Implement repository identity and bounded read-only Git methods**

```ts
// src/worker/git/repository-inspector.ts
export interface RepositoryIdentity {
  rootRealpath: string;
  commonDirRealpath: string;
  gitDirRealpath: string;
  headOid: string;
  headRef: string;
}
export interface GitStatus { clean: boolean; entries: string[]; inProgressOperation: string | null }
export interface GitDiffFile { path: string; status: string; additions: number; deletions: number }
export interface GitWorktreeOwner { pathRealpath: string; headOid: string; branchRef: string | null; locked: boolean }
export interface GitLogEntry { oid: string; parents: string[]; subject: string; authoredAt: string }

export class GitReadService {
  constructor(private readonly git: GitCommandRunner) {}
  inspectRepository(selectedPath: string): Promise<RepositoryIdentity>;
  status(input: { repositoryRootRealpath: string; worktreePathRealpath: string }): Promise<GitStatus>;
  diff(input: { repositoryRootRealpath: string; fromOid: string; toOid?: string; pathspec?: string[] }): Promise<{ patch: string; files: GitDiffFile[] }>;
  show(input: { repositoryRootRealpath: string; oid: string; path?: string }): Promise<string>;
  log(input: { repositoryRootRealpath: string; startOid: string; maxCount: number }): Promise<GitLogEntry[]>;
  listWorktrees(repositoryRootRealpath: string): Promise<GitWorktreeOwner[]>;
}
```

`inspectRepository` must `realpath(selectedPath)`, run `rev-parse --show-toplevel`, `rev-parse --path-format=absolute --git-common-dir`, `rev-parse --path-format=absolute --git-dir`, `rev-parse --verify HEAD^{commit}`, and `symbolic-ref HEAD`, then `realpath` all returned directories. Reject a bare repository, detached `HEAD`, a missing commit, or a selected path whose real top-level differs from the stored project root. `listWorktrees` must parse `git worktree list --porcelain -z`; do not split human-formatted output on spaces.

`status` runs `status --porcelain=v2 -z --untracked-files=all` and checks `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `REBASE_HEAD`, and `BISECT_LOG` through `rev-parse --git-path`. `diff`, `show`, and `log` validate every OID/ref/pathspec before placing it in argv, use `--` before user pathspecs, and enforce `maxCount` from 1 through 200.

- [ ] **Step 5: Implement canonical path authorization including nonexistent leaves**

```ts
// src/worker/git/workspace-path-guard.ts
export interface WorkspaceGuardIdentity {
  repositoryRootRealpath: string;
  worktreeRootRealpath: string;
  gitCommonDirRealpath: string;
}
export class WorkspacePathGuard {
  static async create(identity: WorkspaceGuardIdentity): Promise<WorkspacePathGuard>;
  resolveReadable(candidate: string): Promise<string>;
  resolveWritable(candidate: string): Promise<string>;
  assertChildCwd(candidate: string): Promise<string>;
}
```

For an existing candidate, compare its `realpath`; for a nonexistent leaf, walk upward with `lstat` until the nearest existing ancestor, resolve that ancestor, then append only the remaining validated basename components. Containment is true only when `relative(root, candidate)` is `''` or neither starts with `..${sep}` nor is absolute. Reject the worktree `.git` file/directory, any resolved path at or below `gitCommonDirRealpath`, NUL, empty components, and paths outside `worktreeRootRealpath`. `resolveReadable` may read repository files but still rejects Git metadata; `resolveWritable` and `assertChildCwd` are restricted to the Agent's assigned worktree.

- [ ] **Step 6: Build a real Git fixture and integration tests for reads and identity**

```ts
// tests/fixtures/git-repository.ts
export interface GitRepositoryFixture {
  root: string;
  commonDirRealpath: string;
  initialOid: string;
  run(argv: readonly string[], cwd?: string): Promise<{ stdout: string; stderr: string }>;
  write(relativePath: string, contents: string): Promise<void>;
  cleanup(): Promise<void>;
}
export async function createGitRepositoryFixture(): Promise<GitRepositoryFixture>;
export async function makePathGuardFixture(): Promise<WorkspaceGuardIdentity & { identity: WorkspaceGuardIdentity; commonDirRealpath: string }>;
```

The fixture uses `mkdtemp`, the same argv-only `GitCommandRunner`, an initial committed file, and explicit cleanup registered by each test. It must never invoke `exec`, a shell, command substitution, or a string command. Add integration assertions for spaces in repository paths, a linked worktree, detached-HEAD rejection, a valid 40/64-character OID, porcelain-v2 status, binary diff bytes, and `worktree list -z` branch ownership.

Run: `pnpm test:unit -- tests/unit/git/git-command-runner.test.ts tests/unit/git/workspace-path-guard.test.ts && pnpm test:integration -- tests/integration/git/repository-inspector.test.ts && pnpm typecheck`

Expected: all focused tests PASS; traversal/symlink/common-dir cases fail closed; a repository path containing spaces is handled as one argv element.

- [ ] **Step 7: Commit the Git read boundary, guard, and fixtures**

```bash
git add src/worker/git/git-command-runner.ts src/worker/git/repository-inspector.ts src/worker/git/workspace-path-guard.ts tests/fixtures/git-repository.ts tests/unit/git/git-command-runner.test.ts tests/unit/git/workspace-path-guard.test.ts tests/integration/git/repository-inspector.test.ts
git commit -m "feat(git): add canonical read and path safety boundary"
```

### Task 5: Mention-Driven Task Creation and Durable Capability Receipts

**Files:**
- Create: `src/worker/tasks/mention-parser.ts`
- Create: `src/worker/tasks/task-service.ts`
- Create: `src/worker/approvals/canonical-json.ts`
- Create: `src/worker/approvals/approval-service.ts`
- Create: `src/worker/approvals/approved-workspace.ts`
- Create: `tests/fixtures/task-engine.ts`
- Modify: `src/shared/contracts/protocol.ts`
- Modify: `src/worker/protocol/worker-router.ts`
- Test: `tests/unit/tasks/mention-parser.test.ts`
- Test: `tests/integration/tasks/task-approval.test.ts`
- Test: `tests/unit/approvals/approved-workspace.test.ts`

**Interfaces:**
- Consumes: Milestone 1 `message.post` handler/EventStore, `TaskRepository`, `ApprovalRepository`, `GitReadService.inspectRepository/status`, `WorkspacePathGuard`, transition function, and injected `id(): string`, `now(): string`, `workerGeneration`, and absolute managed worktree root.
- Produces: `parseAgentMentions(text)`, `TaskService.createFromUserMessage`, `TaskService.decideScope`, `ApprovalService.createReceipt/assertTaskCapability/grantAdditionalRounds`, `canonicalJson/hashCanonical`, and `ApprovedWorkspace.readText/writeText`.

The new `tests/fixtures/task-engine.ts` exports `createApprovedTaskFixture(options?)` with concrete `service`, `tasks`, `approvals`, `events`, `repository`, `captureGitState`, `generation`, and cleanup fields. Later tasks extend this one fixture rather than declaring unimplemented global helpers.

- [ ] **Step 1: Write failing mention, no-preapproval-mutation, receipt, and symlink-write tests**

```ts
// tests/unit/tasks/mention-parser.test.ts
import { expect, it } from 'vitest';
import { parseAgentMentions } from '../../../src/worker/tasks/mention-parser';

it.each([
  ['@Claude fix this', ['claude']], ['please ask @Codex.', ['codex']],
  ['`@Claude` is documentation', []], ['email@Claude.com', []], ['@Claude and @Codex compare', ['claude', 'codex']],
])('parses supported user mentions from %s', (text, expected) => {
  expect(parseAgentMentions(text)).toEqual(expected);
});
```

```ts
// tests/integration/tasks/task-approval.test.ts
it('creates AwaitingApproval from a user mention without mutating Git', async () => {
  const fixture = await createApprovedTaskFixture();
  const before = await fixture.captureGitState();
  const result = await fixture.service.createFromUserMessage({
    roomId: 'room-1', messageEventId: 'event-1', text: '@Claude implement parser', explicitLead: null,
    idempotencyKey: 'message-1',
  });
  expect(result.task.state).toBe('AwaitingApproval');
  expect(result.task.leadProvider).toBe('claude');
  expect(result.approvalRequest.scope).toMatchObject({ allowCollaborator: true, toolNetwork: false, collaborationRoundBudget: 2 });
  expect(await fixture.captureGitState()).toEqual(before);
  expect(fixture.events.byType('approval.requested')).toHaveLength(1);
});

it('requires an explicit lead when both supported Agents are mentioned', async () => {
  const fixture = await createApprovedTaskFixture();
  await expect(fixture.service.createFromUserMessage({
    roomId: 'room-1', messageEventId: 'event-2', text: '@Claude and @Codex compare', explicitLead: null,
    idempotencyKey: 'message-2',
  })).rejects.toThrow('AMBIGUOUS_LEAD_PROVIDER');
});
```

Add unit tests proving canonical object-key ordering produces the same `scopeHash`, any capability change produces a different hash, task-scope receipts survive a worker generation change, sensitive/final receipts do not, unapproved command/network/write access is denied, and a symlink created after approval is re-resolved at the moment of each write.

- [ ] **Step 2: Run focused tests and verify task creation/approval modules are missing**

Run: `pnpm test:unit -- tests/unit/tasks/mention-parser.test.ts tests/unit/approvals/approved-workspace.test.ts && pnpm test:integration -- tests/integration/tasks/task-approval.test.ts`

Expected: FAIL with missing modules and no `approval.requested` event variant.

- [ ] **Step 3: Implement deterministic mention parsing and stable receipt hashing**

```ts
// src/worker/tasks/mention-parser.ts
import type { AgentProvider } from '../../shared/contracts/domain';

export function parseAgentMentions(text: string): AgentProvider[] {
  const withoutInlineCode = text.replace(/`[^`\n]*`/g, ' ');
  const matches = withoutInlineCode.matchAll(/(^|[^\p{L}\p{N}_@])@(Claude|Codex)\b/giu);
  return [...new Set([...matches].map((match) => match[2].toLowerCase() as AgentProvider))];
}
```

```ts
// src/worker/approvals/canonical-json.ts
import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .filter(([, item]) => item !== undefined);
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}
export function hashCanonical(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}
```

Reject `NaN`, infinities, functions, symbols, bigint, and cyclic values before hashing. Preserve array order; sort capability arrays at construction time so semantically identical scopes hash identically.

- [ ] **Step 4: Implement task creation and durable scope decisions**

```ts
// src/worker/tasks/task-service.ts
export interface CreateTaskFromMessageInput {
  roomId: string;
  messageEventId: string;
  text: string;
  explicitLead: AgentProvider | null;
  idempotencyKey: string;
}
export class TaskService {
  createFromUserMessage(input: CreateTaskFromMessageInput): Promise<{
    task: TaskRecord;
    approvalRequest: ApprovalRequest;
    baseSnapshotWarning: 'main_worktree_dirty' | null;
  }>;
  decideScope(input: {
    taskId: string; approvalRequestId: string; decision: 'approved' | 'rejected';
    displayedScopeHash: string; workerGeneration: string; idempotencyKey: string;
  }): Promise<TaskRecord>;
}
```

`createFromUserMessage` loads the Room/Project and performs read-only Git inspection first, then inside one database transaction revalidates those IDs, stores `targetRef` plus immutable `baseOid`, inserts `AwaitingApproval` and a durable pending `ApprovalRequest`, and appends `task.created` plus `approval.requested`. It parses mentions and requires exactly one selected Lead (or validates `explicitLead` is one of the mentions). It does not insert an approved receipt until the user decides. Its planned writable root is exactly `<managedWorktreeRoot>/<projectId>/<taskId>/lead`; `toolNetwork` defaults false; `collaborationRoundBudget` is clamped to 0–2; allowed command classes are explicit values from the UI request.

`decideScope` reloads the pending request, recomputes the displayed scope hash, rejects stale/mismatched content, calls `ApprovalRepository.decideRequest` to atomically mark the request decided and insert one immutable approved/rejected `ApprovalReceipt`, transitions approved tasks to `Preparing` and rejected tasks to `Cancelled`, and appends `approval.decided`. It does not create a branch/worktree itself; Task 6 performs preparation only after the committed approved receipt is readable.

```ts
// src/worker/approvals/approval-service.ts
export class ApprovalService {
  createReceipt(input: {
    id: string; requestId: string; taskId: string; kind: ApprovalReceipt['kind']; decision: ApprovalReceipt['decision'];
    scope: ApprovalReceipt['scope']; workerGeneration: string; decidedAt: string;
  }): ApprovalReceipt;
  assertTaskCapability(receipt: ApprovalReceipt, currentGeneration: string): TaskCapabilityScope;
  grantAdditionalRounds(input: {
    task: TaskRecord; receiptId: string; additionalRounds: 1 | 2;
    workerGeneration: string; decidedAt: string; idempotencyKey: string;
  }): TaskRecord;
}
```

Task-scope receipts set `survivesWorkerRestart: true`; additional-round, external-operation, and final-merge receipts set it false. Additional-round approval requires a new receipt and transition; it cannot be inferred from a chat message or Provider event.

- [ ] **Step 5: Implement a worktree-only filesystem capability**

```ts
// src/worker/approvals/approved-workspace.ts
export class ApprovedWorkspace {
  constructor(
    private readonly guard: WorkspacePathGuard,
    private readonly operations: JournaledOperationRunner,
    private readonly context: {
      projectId: string; taskId: string; commonDirRealpath: string;
      workerGeneration: string; nextOperationId(): string; now(): string;
    },
  ) {}
  async readText(candidate: string): Promise<string> {
    return readFile(await this.guard.resolveReadable(candidate), 'utf8');
  }
  async writeText(candidate: string, contents: string): Promise<void> {
    const resolved = await this.guard.resolveWritable(candidate);
    const contentHash = hashBytes(Buffer.from(contents, 'utf8'));
    await this.operations.run({
      intent: workspaceWriteIntent(this.context, resolved, contentHash),
      execute: async () => {
        await mkdir(dirname(resolved), { recursive: true });
        const checkedAgain = await this.guard.resolveWritable(resolved);
        if (checkedAgain !== resolved) throw new Error('PATH_CHANGED_DURING_AUTHORIZATION');
        const handle = await open(resolved, constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(contents, 'utf8'); } finally { await handle.close(); }
      },
      observe: async () => {
        const actualHash = hashBytes(await readFile(await this.guard.resolveReadable(resolved)));
        return actualHash === contentHash
          ? { outcome: 'applied', actual: { path: resolved, contentHash: actualHash }, result: undefined }
          : { outcome: 'conflict', actual: { path: resolved, contentHash: actualHash } };
      },
    });
  }
}
```

Define `hashBytes` and `workspaceWriteIntent` in this file with SHA-256, operation type `workspace.write`, the exact canonical path/content hash, a fresh `operationId = context.nextOperationId()`, and `idempotencyKey = workspace-write:<operationId>`. The write itself stays between durable intent and observation. Use `open` with `O_NOFOLLOW` for the final file on macOS and validate the parent immediately before creation, so a symlink swap between checks fails closed. Expose no delete, chmod, rename-outside-root, process, SQLite, Git, or arbitrary file-descriptor method.

- [ ] **Step 6: Extend message routing without a second command path**

Keep `message.post` as the user action. Extend its payload with optional `leadProvider` and explicit scope display fields. After Milestone 1 appends the user message, call `TaskService.createFromUserMessage` only when `parseAgentMentions` is non-empty; reuse the message request's durable idempotency key with suffixes `:task`, `:approval-request`, and `:timeline`. Register `task.approveScope` and `task.grantAdditionalRound` as `CommandHandler` implementations in the existing router. Duplicate requests must return the previously stored task/receipt and must not append duplicate room events.

- [ ] **Step 7: Run approval integration tests and the full unit suite**

Run: `pnpm test:unit -- tests/unit/tasks/mention-parser.test.ts tests/unit/approvals/approved-workspace.test.ts && pnpm test:integration -- tests/integration/tasks/task-approval.test.ts && pnpm test:unit && pnpm typecheck`

Expected: all commands PASS; `@Claude`/`@Codex` create exactly one pending task, an ambiguous Lead is rejected, no Git mutation occurs before approval, stale hashes fail closed, and symlink-swapped writes stay outside neither the worktree nor common dir.

- [ ] **Step 8: Commit mention-driven tasks and capability approval receipts**

```bash
git add src/worker/tasks/mention-parser.ts src/worker/tasks/task-service.ts src/worker/approvals/canonical-json.ts src/worker/approvals/approval-service.ts src/worker/approvals/approved-workspace.ts src/shared/contracts/protocol.ts src/worker/protocol/worker-router.ts tests/fixtures/task-engine.ts tests/unit/tasks/mention-parser.test.ts tests/integration/tasks/task-approval.test.ts tests/unit/approvals/approved-workspace.test.ts
git commit -m "feat(approvals): gate mentioned tasks with durable capabilities"
```

### Task 6: `GitManager` Worktrees, Branches, and Immutable Checkpoints

**Files:**
- Create: `src/worker/git/git-artifact-repository.ts`
- Create: `src/worker/git/git-manager.ts`
- Modify: `tests/fixtures/git-repository.ts`
- Test: `tests/integration/git/git-manager-worktrees.test.ts`
- Test: `tests/integration/git/git-manager-checkpoints.test.ts`
- Test: `tests/unit/git/provider-git-boundary.test.ts`

**Interfaces:**
- Consumes: `GitCommandRunner`, `GitReadService`, `WorkspacePathGuard`, `RepositoryLock`, `JournaledOperationRunner`, `OperationJournal`, Task 2 tables, approved `TaskRecord`, managed worktree root, and injected ID/time factories.
- Produces: `GitArtifactRepository`, `GitManager.ensureAgentWorktree`, `GitManager.createCheckpoint`, `GitManager.getReadService`, immutable `refs/branchestra/checkpoints/<checkpointId>`, and one branch/worktree per executing Agent.

Extend `tests/fixtures/git-repository.ts` with `createGitManagerFixture()` and `createPreparedLeadFixture()`. The first returns a real repository, database/repositories, journal/lock/manager, Git argv history, and cleanup; the second additionally creates and returns the Lead `WorktreeRecord`, hook sentinel helpers, canonical file writers/readers, and the same cleanup.

- [ ] **Step 1: Write failing real-repository tests for isolated worktrees and immutable refs**

```ts
// tests/integration/git/git-manager-worktrees.test.ts
import { describe, expect, it } from 'vitest';
import { createGitManagerFixture } from '../../fixtures/git-repository';

describe('GitManager worktrees', () => {
  it('creates distinct Lead and Collaborator branches from the recorded base exactly once', async () => {
    const fixture = await createGitManagerFixture();
    const lead = await fixture.manager.ensureAgentWorktree({
      projectId: 'project-1', taskId: 'task-1', role: 'lead', baseOid: fixture.repository.initialOid,
      repositoryRootRealpath: fixture.repository.root, commonDirRealpath: fixture.repository.commonDirRealpath,
      workerGeneration: '00000000-0000-4000-8000-000000000001', idempotencyKey: 'worktree-lead',
    });
    const collaborator = await fixture.manager.ensureAgentWorktree({
      projectId: 'project-1', taskId: 'task-1', role: 'collaborator', baseOid: fixture.repository.initialOid,
      repositoryRootRealpath: fixture.repository.root, commonDirRealpath: fixture.repository.commonDirRealpath,
      workerGeneration: '00000000-0000-4000-8000-000000000001', idempotencyKey: 'worktree-collaborator',
    });
    expect(lead.branchRef).toBe('refs/heads/branchestra/task-1/lead');
    expect(collaborator.branchRef).toBe('refs/heads/branchestra/task-1/collaborator');
    expect(lead.pathRealpath).not.toBe(collaborator.pathRealpath);
    expect((await fixture.manager.ensureAgentWorktree({
      projectId: 'project-1', taskId: 'task-1', role: 'lead', baseOid: fixture.repository.initialOid,
      repositoryRootRealpath: fixture.repository.root, commonDirRealpath: fixture.repository.commonDirRealpath,
      workerGeneration: '00000000-0000-4000-8000-000000000001', idempotencyKey: 'worktree-lead',
    })).id).toBe(lead.id);
  });
});
```

```ts
// tests/integration/git/git-manager-checkpoints.test.ts
it('commits with app identity, skips hooks, and creates a create-only checkpoint ref', async () => {
  const fixture = await createPreparedLeadFixture();
  await fixture.repository.writeAt(fixture.lead.pathRealpath, 'feature.txt', 'implemented\n');
  await fixture.installHookThatWrites('pre-commit', fixture.hookSentinel);
  const checkpoint = await fixture.manager.createCheckpoint({
    projectId: 'project-1', taskId: 'task-1', worktree: fixture.lead,
    authorProvider: 'claude', purpose: 'implementation', message: 'Implement feature',
    workerGeneration: '00000000-0000-4000-8000-000000000001', idempotencyKey: 'checkpoint-1', checkpointId: 'checkpoint-1',
  });
  expect(await fixture.git('show', '-s', '--format=%an <%ae>', checkpoint.oid))
    .toBe('Branchestra <branchestra@localhost>');
  expect(await fixture.pathExists(fixture.hookSentinel)).toBe(false);
  expect(await fixture.git('rev-parse', 'refs/branchestra/checkpoints/checkpoint-1'))
    .toBe(checkpoint.oid);
  await expect(fixture.manager.createCheckpoint({
    projectId: 'project-1', taskId: 'task-1', worktree: fixture.lead,
    authorProvider: 'claude', purpose: 'implementation', message: 'Different content',
    workerGeneration: '00000000-0000-4000-8000-000000000001', idempotencyKey: 'checkpoint-1-other', checkpointId: 'checkpoint-1',
  })).rejects.toThrow('IMMUTABLE_CHECKPOINT_REF_CONFLICT');
});
```

Add a source-boundary unit test that walks the TypeScript import graph under `src/worker/providers` and fails if any Provider module imports `src/worker/git/git-manager`, `node:child_process`, `src/worker/storage`, or exports a mutating Git command. Read-only context adapters may import only `GitReadService` types through a dedicated injected port.

- [ ] **Step 2: Run focused tests and verify `GitManager` is absent**

Run: `pnpm test:unit -- tests/unit/git/provider-git-boundary.test.ts && pnpm test:integration -- tests/integration/git/git-manager-worktrees.test.ts tests/integration/git/git-manager-checkpoints.test.ts`

Expected: FAIL because `git-manager`, `git-artifact-repository`, and the extended fixture do not exist.

- [ ] **Step 3: Implement typed artifact persistence**

```ts
// src/worker/git/git-artifact-repository.ts
export class GitArtifactRepository {
  constructor(private readonly db: Database) {}
  insertWorktree(record: WorktreeRecord): void;
  getWorktree(taskId: string, role: 'lead' | 'collaborator'): WorktreeRecord | null;
  listWorktrees(taskId: string): WorktreeRecord[];
  updateCheckpoint(worktreeId: string, oid: string): void;
  insertCheckpoint(record: CheckpointRecord): void;
  getCheckpoint(checkpointId: string): CheckpointRecord | null;
  listCheckpoints(taskId: string): CheckpointRecord[];
  insertCandidate(candidate: IntegrationCandidate, checkpointIds: string[]): void;
  getCandidate(candidateId: string): IntegrationCandidate | null;
  listTestResults(candidateId: string): TestResultRecord[];
  insertTestResult(result: TestResultRecord): void;
}
```

Map all columns explicitly. `insertCheckpoint` verifies that the worktree belongs to the same task and relies on the Task 2 trigger to reject OID/ref updates. Candidate checkpoint ordinals preserve the Lead's declared integration order.

- [ ] **Step 4: Implement exact `GitManager` worktree and checkpoint APIs**

```ts
// src/worker/git/git-manager.ts
export interface EnsureAgentWorktreeInput {
  projectId: string; taskId: string; role: 'lead' | 'collaborator'; baseOid: string;
  repositoryRootRealpath: string; commonDirRealpath: string;
  workerGeneration: string; idempotencyKey: string;
}
export interface CreateCheckpointInput {
  projectId: string; taskId: string; worktree: WorktreeRecord; authorProvider: AgentProvider;
  purpose: CheckpointRecord['purpose']; message: string; checkpointId: string;
  workerGeneration: string; idempotencyKey: string;
}
export class GitManager {
  getReadService(): GitReadService;
  ensureAgentWorktree(input: EnsureAgentWorktreeInput): Promise<WorktreeRecord>;
  createCheckpoint(input: CreateCheckpointInput): Promise<CheckpointRecord>;
}
```

`ensureAgentWorktree` validates `taskId` against `/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`, derives only `refs/heads/branchestra/<taskId>/<role>` and `<managedRoot>/<projectId>/<taskId>/<role>`, then acquires `RepositoryLock(commonDirRealpath)`. It records an operation intent containing `{ branchRef, path, baseOid }`. Its idempotent executor handles exactly these observations:

| Branch | Worktree | Action |
|---|---|---|
| absent | absent | `git worktree add -b <shortBranch> <path> <baseOid>` |
| present at `baseOid` | absent | `git worktree add <path> <shortBranch>` |
| present at expected OID | present at expected realpath/ref | no-op |
| any other combination | any other combination | observe `conflict`; do not force, reset, remove, or reuse |

After execution, re-run `worktree list --porcelain -z` and `rev-parse <branchRef>^{commit}`; persist a `WorktreeRecord` only after both match. Realpath the created path and assert its `.git` resolves through Git to the expected common dir. Never call `git worktree remove` on error or cancellation.

`createCheckpoint` runs only after the Agent run has stopped writing and under the same repository lock. It creates two journaled operations:

1. `checkpoint.commit`: verify worktree `HEAD` equals the stored expected OID, run `git add --all`, then `git commit --allow-empty -m <message> --trailer Branchestra-Checkpoint-Id=<checkpointId>` with hooks disabled and app identity; observe `HEAD`, parent, trailer, index, and commit author.
2. `checkpoint.ref.create`: run `git update-ref refs/branchestra/checkpoints/<checkpointId> <oid> 0000000000000000000000000000000000000000`; if the ref already exists, accept only the same OID; observe the full OID before persisting the checkpoint and updating the worktree row.

No code path accepts a ref, branch, message trailer, or worktree location from Provider output. The task engine supplies IDs and messages after validating their bounded length.

- [ ] **Step 5: Add partial-state, race, and preservation tests**

Extend the integration tests to cover branch-created/worktree-missing recovery during the same live request, an external branch at the wrong OID, a pre-existing directory, concurrent tasks on the same repository, parallel tasks on distinct repositories, empty checkpoints, 64-character object formats when the fixture supports SHA-256, and cancellation after `worktree add`. Assert every case retains all visible artifacts and produces `completed` or `needs_attention` journal state rather than deleting anything.

- [ ] **Step 6: Run all Git tests and type checking**

Run: `pnpm test:unit -- tests/unit/git/provider-git-boundary.test.ts && pnpm test:integration -- tests/integration/git/repository-inspector.test.ts tests/integration/git/git-manager-worktrees.test.ts tests/integration/git/git-manager-checkpoints.test.ts && pnpm typecheck`

Expected: all tests PASS; hooks never run, refs never move, each role has a distinct worktree, and same-repository mutations are serialized.

- [ ] **Step 7: Commit the sole Git mutation boundary**

```bash
git add src/worker/git/git-artifact-repository.ts src/worker/git/git-manager.ts tests/integration/git/git-manager-worktrees.test.ts tests/integration/git/git-manager-checkpoints.test.ts tests/unit/git/provider-git-boundary.test.ts tests/fixtures/git-repository.ts
git commit -m "feat(git): manage isolated worktrees and immutable checkpoints"
```

### Task 7: Narrow Provider Port, Deterministic Mock Runs, Cancellation, and Process Loss

**Files:**
- Create: `src/worker/tasks/provider-port.ts`
- Create: `src/worker/providers/mock-provider.ts`
- Create: `src/worker/tasks/task-engine.ts`
- Modify: `src/worker/tasks/task-repository.ts`
- Modify: `tests/fixtures/task-engine.ts`
- Test: `tests/unit/providers/mock-provider.test.ts`
- Test: `tests/integration/tasks/task-engine-run.test.ts`
- Test: `tests/integration/tasks/task-engine-cancellation.test.ts`

**Interfaces:**
- Consumes: approved `TaskRecord`, `TaskProviderPort`, `ApprovedWorkspace`, `GitManager.ensureAgentWorktree/createCheckpoint`, state transitions, repositories/EventStore, journal, and injected context/version/hash data. It consumes no SDK or CLI type.
- Produces: `TaskProviderPort`, `TaskProviderRunRequest`, `TaskProviderResumeRequest`, `TaskProviderRunHandle`, `TaskProviderEvent`, `TaskProviderRunResult`, `MockProvider`, and `TaskEngine.startApprovedTask/cancel/handleProcessLoss`.

Extend `tests/fixtures/task-engine.ts` with `createTaskEngineFixture({ mockScript, initialState? })` returning typed `engine`, `mock`, `tasks`, `events`, `repository`, `manager`, `generation`, Lead file/ref query helpers, and `cleanup()`. Every helper used in the tests below is a method on that returned object.

- [ ] **Step 1: Write failing tests for event-before-UI durability, cancellation, and artifact retention**

```ts
// tests/integration/tasks/task-engine-run.test.ts
it('prepares an approved Lead worktree, records mock events, writes only through the approved workspace, and checkpoints', async () => {
  const fixture = await createTaskEngineFixture({
    mockScript: [
      { type: 'assistant.message', text: 'Starting' },
      { type: 'workspace.writeText', relativePath: 'feature.txt', contents: 'done\n' },
      { type: 'run.completed', summary: 'implemented' },
    ],
  });
  const result = await fixture.engine.startApprovedTask('task-1', 'start-1');
  expect(result.state).toBe('Checkpoint');
  expect(await fixture.readLeadFile('feature.txt')).toBe('done\n');
  expect(fixture.events.types()).toEqual(expect.arrayContaining(['agent.run', 'checkpoint.created', 'task.transitioned']));
  expect(fixture.events.persistedBeforePublish()).toBe(true);
});
```

```ts
// tests/integration/tasks/task-engine-cancellation.test.ts
it('settles CancelRequested and preserves branch, worktree, commit, and uncommitted content', async () => {
  const fixture = await createTaskEngineFixture({
    mockScript: [
      { type: 'workspace.writeText', relativePath: 'partial.txt', contents: 'keep me\n' },
      { type: 'waitForCancel' },
    ],
  });
  const running = fixture.engine.startApprovedTask('task-1', 'start-1');
  await fixture.mock.waitUntilBlocked();
  await fixture.engine.cancel('task-1', 'user', 'cancel-1');
  await running;
  expect(fixture.tasks.getRequired('task-1').state).toBe('Cancelled');
  expect(await fixture.readLeadFile('partial.txt')).toBe('keep me\n');
  expect(await fixture.leadBranchExists()).toBe(true);
  expect(fixture.gitMutationCalls()).not.toContain('worktree remove');
});
```

Add a process-loss test that moves each non-terminal running phase to `Interrupted`, records its exact prior phase and collaboration count, marks active runs `interrupted`, leaves every Git artifact unchanged, and never calls `startRun` or `resumeRun` during loss handling.

- [ ] **Step 2: Run focused tests and verify the Provider port/engine are absent**

Run: `pnpm test:unit -- tests/unit/providers/mock-provider.test.ts && pnpm test:integration -- tests/integration/tasks/task-engine-run.test.ts tests/integration/tasks/task-engine-cancellation.test.ts`

Expected: FAIL with missing `provider-port`, `mock-provider`, and `task-engine` modules.

- [ ] **Step 3: Define the SDK-independent Provider port exactly**

```ts
// src/worker/tasks/provider-port.ts
export interface ApprovedRunCapabilities {
  workspaceRootRealpath: string;
  readableRootsRealpath: string[];
  commandClasses: TaskCapabilityScope['commandClasses'];
  toolNetwork: boolean;
  allowCollaborator: boolean;
  maxRunMs: number;
}
export interface TaskProviderRunRequest {
  runId: string; taskId: string; provider: AgentProvider; role: AgentRole;
  worktreePath: string; instruction: string; contextVersion: number; contextHash: string;
  checkpointOid: string | null; approvedCapabilities: ApprovedRunCapabilities;
}
export interface TaskProviderResumeRequest extends TaskProviderRunRequest {
  providerSessionId: string;
  recoveryBrief: string;
}
export type TaskProviderEvent =
  | { type: 'assistant.message'; text: string }
  | { type: 'workspace.writeText'; relativePath: string; contents: string }
  | { type: 'test.request'; commandId: string }
  | { type: 'collaborator.request'; purpose: 'parallel_implementation' | 'review' }
  | { type: 'review.findings'; checkpointOid: string; findings: string[] }
  | { type: 'run.completed'; summary: string }
  | { type: 'run.failed'; code: string; message: string };
export interface TaskProviderRunResult {
  outcome: 'completed' | 'cancelled' | 'failed';
  summary: string;
  error: { code: string; message: string } | null;
}
export interface TaskProviderRunHandle {
  runId: string;
  sessionId: string | null;
  events: AsyncIterable<TaskProviderEvent>;
  completion: Promise<TaskProviderRunResult>;
}
export interface TaskProviderPort {
  startRun(request: TaskProviderRunRequest): Promise<TaskProviderRunHandle>;
  resumeRun(request: TaskProviderResumeRequest): Promise<TaskProviderRunHandle>;
  cancelRun(runId: string, reason: 'user' | 'quit' | 'timeout'): Promise<void>;
}
```

Milestone 3 may extend `TaskProviderRunRequest` with its validated external executable and enforcement profile, and its `ProviderAdapter` may extend this port. The task engine must continue importing only this file, so SDK client/thread/process types never leak into workflow code.

- [ ] **Step 4: Implement the deterministic in-process Mock Provider**

```ts
// src/worker/providers/mock-provider.ts
export type MockProviderStep =
  | TaskProviderEvent
  | { type: 'waitForCancel' }
  | { type: 'throw'; code: string; message: string };
export interface MockProviderScript {
  sessionId: string;
  steps: MockProviderStep[];
}
export class MockProvider implements TaskProviderPort {
  constructor(private readonly scriptForRun: (request: TaskProviderRunRequest | TaskProviderResumeRequest) => MockProviderScript) {}
  startRun(request: TaskProviderRunRequest): Promise<TaskProviderRunHandle>;
  resumeRun(request: TaskProviderResumeRequest): Promise<TaskProviderRunHandle>;
  cancelRun(runId: string, reason: 'user' | 'quit' | 'timeout'): Promise<void>;
  waitUntilBlocked(): Promise<void>;
}
```

Implement events with a bounded async queue and one `AbortController` per run. `waitForCancel` resolves only after `cancelRun`; cancellation closes the queue and completion resolves `{ outcome: 'cancelled' }`. A second cancel is idempotent. Unknown run IDs throw `MOCK_RUN_NOT_FOUND`. Resume uses the provided persisted session ID and a separately registered resume script. This module must not import `node:child_process`, `GitManager`, a database, an SDK, or a CLI path.

- [ ] **Step 5: Implement task-run orchestration with durable event ordering**

```ts
// src/worker/tasks/task-engine.ts
export class TaskEngine {
  startApprovedTask(taskId: string, idempotencyKey: string): Promise<TaskRecord>;
  cancel(taskId: string, reason: 'user' | 'quit' | 'timeout', idempotencyKey: string): Promise<TaskRecord>;
  handleProcessLoss(taskId: string, lostGeneration: string, idempotencyKey: string): Promise<TaskRecord>;
}
```

`startApprovedTask` reads and revalidates the durable task-scope receipt, transitions `Preparing`, calls `GitManager.ensureAgentWorktree`, transitions `Working`, inserts `agent_runs`, and starts the Provider. For each mock event it first persists the normalized `agent.run` room event, then publishes it. `workspace.writeText` invokes only `ApprovedWorkspace`; `run.completed` stops event consumption, creates a checkpoint through `GitManager`, persists `checkpoint.created`, and transitions to `Checkpoint`. `run.failed` transitions `Failed` without cleanup.

`cancel` first transitions to `CancelRequested` (or direct `Cancelled` for non-running phases), stops new dispatch, calls `cancelRun`, waits for completion up to the capability receipt's bounded grace deadline, persists the final run/Git status, then applies `cancelSettled`. Timeout records a structured failure and lets the Milestone 1 supervisor terminate a registered process group when a future real adapter owns one; the in-process mock only aborts its queue.

`handleProcessLoss` never invokes Provider methods. It marks active runs interrupted, applies the pure process-loss transition, persists the event and latest read-only Git status, and retains all records/artifacts.

- [ ] **Step 6: Add denial and failure cases**

Test a write containing `../`, a symlink escape created after scope approval, an unapproved `test.request`, an unapproved collaborator request, a mock failure, duplicate start/cancel idempotency keys, cancellation at `Preparing`, cancellation after a checkpoint, and process loss in every non-terminal state. Assert denied events fail closed before filesystem/process mutation and every state/event update is durable.

- [ ] **Step 7: Run task engine tests and regressions**

Run: `pnpm test:unit -- tests/unit/providers/mock-provider.test.ts tests/unit/git/provider-git-boundary.test.ts && pnpm test:integration -- tests/integration/tasks/task-engine-run.test.ts tests/integration/tasks/task-engine-cancellation.test.ts && pnpm test:unit && pnpm typecheck`

Expected: all tests PASS; cancellation is idempotent, process loss never restarts a run, and no Provider imports a Git/storage/process mutator.

- [ ] **Step 8: Commit mock runs and task execution**

```bash
git add src/worker/tasks/provider-port.ts src/worker/providers/mock-provider.ts src/worker/tasks/task-engine.ts src/worker/tasks/task-repository.ts tests/fixtures/task-engine.ts tests/unit/providers/mock-provider.test.ts tests/integration/tasks/task-engine-run.test.ts tests/integration/tasks/task-engine-cancellation.test.ts
git commit -m "feat(tasks): run and cancel durable mock agent work"
```

### Task 8: Two-Round Collaboration, Cross-Review, and Lead Integration

**Files:**
- Create: `src/worker/tasks/collaboration-coordinator.ts`
- Create: `src/worker/git/integration-service.ts`
- Modify: `src/worker/git/git-manager.ts`
- Modify: `src/worker/tasks/task-engine.ts`
- Modify: `tests/fixtures/task-engine.ts`
- Test: `tests/integration/tasks/collaboration-rounds.test.ts`
- Test: `tests/integration/git/lead-integration.test.ts`

**Interfaces:**
- Consumes: task round budget/state machine, approved `allowCollaborator`, `TaskProviderPort`, distinct Lead/Collaborator worktrees, immutable checkpoints, Git read methods, journal/lock, and `GitArtifactRepository`.
- Produces: `CollaborationCoordinator.requestRound`, `CollaborationCoordinator.completeReview`, `GitManager.integrateCheckpoint`, `IntegrationService.integrateSelectedCheckpoints`, structured review/divergence/conflict results, and a Lead worktree ready for candidate verification.

Extend `tests/fixtures/task-engine.ts` with `createCollaborationFixture(options?)` and `createIntegrationFixture(options)`; both return the concrete coordinators plus Lead/Collaborator records/checkpoints, mock request history, Git mutation history, file readers, and cleanup.

- [ ] **Step 1: Write failing two-round and Git-conflict integration tests**

```ts
// tests/integration/tasks/collaboration-rounds.test.ts
it('runs exactly two automatic rounds against immutable checkpoint OIDs', async () => {
  const fixture = await createCollaborationFixture();
  await fixture.engine.startApprovedTask('task-1', 'start-lead');
  const firstLeadCheckpoint = fixture.latestCheckpoint('lead');
  await fixture.collaboration.requestRound({ taskId: 'task-1', purpose: 'review', idempotencyKey: 'round-1' });
  expect(fixture.tasks.getRequired('task-1')).toMatchObject({ state: 'Review1', collaborationRoundsUsed: 1 });
  expect(fixture.mock.lastRequest('codex').checkpointOid).toBe(firstLeadCheckpoint.oid);
  await fixture.collaboration.completeReview({ taskId: 'task-1', findings: ['rename symbol'], idempotencyKey: 'review-1' });
  await fixture.runLeadRevision();
  const revisionCheckpoint = fixture.latestCheckpoint('lead');
  await fixture.collaboration.requestRound({ taskId: 'task-1', purpose: 'review', idempotencyKey: 'round-2' });
  expect(fixture.tasks.getRequired('task-1')).toMatchObject({ state: 'Review2', collaborationRoundsUsed: 2 });
  expect(fixture.mock.lastRequest('codex').checkpointOid).toBe(revisionCheckpoint.oid);
  await expect(fixture.collaboration.requestRound({ taskId: 'task-1', purpose: 'review', idempotencyKey: 'round-3' }))
    .rejects.toThrow('COLLABORATION_ROUND_BUDGET_EXHAUSTED');
});

it('does not spend a round for a human-directed revision', async () => {
  const fixture = await createCollaborationFixture({ state: 'HumanApproval', roundsUsed: 2 });
  await fixture.requestHumanRevision('change copy');
  expect(fixture.tasks.getRequired('task-1')).toMatchObject({
    state: 'Revision', collaborationRoundsUsed: 2, humanRevisionCount: 1, revisionKind: 'human_directed',
  });
  await expect(fixture.collaboration.requestRound({ taskId: 'task-1', purpose: 'review', idempotencyKey: 'human-round' }))
    .rejects.toThrow('COLLABORATION_ROUND_BUDGET_EXHAUSTED');
  await fixture.grantAdditionalRound(1);
  await expect(fixture.collaboration.requestRound({ taskId: 'task-1', purpose: 'review', idempotencyKey: 'granted-round' }))
    .resolves.toMatchObject({ collaborationRoundsUsed: 3, collaborationRoundBudget: 3 });
});
```

```ts
// tests/integration/git/lead-integration.test.ts
it('cherry-picks only a selected immutable Collaborator checkpoint through GitManager', async () => {
  const fixture = await createIntegrationFixture({ conflict: false });
  const result = await fixture.integration.integrateSelectedCheckpoints({
    taskId: 'task-1', leadWorktree: fixture.lead, selectedCheckpointIds: ['collaborator-cp-1'],
    workerGeneration: '00000000-0000-4000-8000-000000000001', idempotencyKey: 'integrate-1',
  });
  expect(result).toMatchObject({ outcome: 'integrated', sourceOids: [fixture.collaboratorCheckpoint.oid] });
  expect(await fixture.readLead('collaborator.txt')).toBe('alternative\n');
  expect(fixture.providerGitMutationCalls()).toEqual([]);
});
```

Add a conflict case that expects `{ outcome: 'conflict', files: ['shared.txt'] }`, keeps the Lead worktree and cherry-pick state visible, transitions to `Revision`, and requires a Lead workspace resolution followed by `GitManager.continueIntegration`; Provider code never receives `git cherry-pick --continue`.

- [ ] **Step 2: Run focused tests and verify collaboration/integration APIs are absent**

Run: `pnpm test:integration -- tests/integration/tasks/collaboration-rounds.test.ts tests/integration/git/lead-integration.test.ts`

Expected: FAIL because `CollaborationCoordinator`, `IntegrationService`, and GitManager integration methods do not exist.

- [ ] **Step 3: Implement round authorization and immutable review context**

```ts
// src/worker/tasks/collaboration-coordinator.ts
export interface RequestRoundInput {
  taskId: string;
  purpose: 'parallel_implementation' | 'review';
  idempotencyKey: string;
}
export class CollaborationCoordinator {
  requestRound(input: RequestRoundInput): Promise<TaskRecord>;
  completeReview(input: { taskId: string; findings: string[]; idempotencyKey: string }): Promise<TaskRecord>;
}
```

`requestRound` verifies the task-scope receipt allows a collaborator, `roundsUsed < roundBudget`, and a full Lead checkpoint record/ref/OID exists. It creates/reuses the Collaborator worktree, transitions via `beginReview`, and starts the other Provider with the Lead checkpoint OID, diff summary, role, room context hash, and read-only Git results. The reviewer never reads the Lead's live directory. For rounds `>= 2`, state remains the `Review2` phase while `collaborationRoundsUsed` carries the exact displayed count; only a durable additional-round receipt can make the budget exceed the initial maximum of two.

`completeReview` persists structured findings and the reviewed checkpoint OID. Round 1 transitions to `Revision`; round 2 or later may proceed to candidate verification with unresolved findings explicitly retained. It never silently starts a third run.

- [ ] **Step 4: Add integration methods to the sole Git mutator**

```ts
// Add to src/worker/git/git-manager.ts
export type IntegrateCheckpointResult =
  | { outcome: 'integrated'; sourceOids: string[]; headOid: string }
  | { outcome: 'conflict'; sourceOids: string[]; files: string[]; headOidBefore: string };
export interface IntegrateCheckpointInput {
  projectId: string; taskId: string; leadWorktree: WorktreeRecord;
  checkpoints: CheckpointRecord[]; workerGeneration: string; idempotencyKey: string;
}
integrateCheckpoint(input: IntegrateCheckpointInput): Promise<IntegrateCheckpointResult>;
continueIntegration(input: {
  projectId: string; taskId: string; leadWorktree: WorktreeRecord;
  expectedSourceOid: string; workerGeneration: string; idempotencyKey: string;
}): Promise<{ headOid: string }>;
```

Under the repository lock, validate every selected record's immutable ref still equals its OID and preserve the caller's declared order. For each OID record intent, verify clean/no-operation Lead status, run `git cherry-pick <oid>`, and observe new `HEAD` and parents. On a conflict, record the exact porcelain-v2 unmerged files and leave the worktree untouched for visible resolution; do not abort, reset, checkout, or delete. `continueIntegration` requires only approved workspace file writes, verifies the recorded `CHERRY_PICK_HEAD` equals `expectedSourceOid`, runs `git add --all` and `git cherry-pick --continue` with disabled hooks/app identity, then observes a clean index and expected parent.

```ts
// src/worker/git/integration-service.ts
export class IntegrationService {
  integrateSelectedCheckpoints(input: {
    taskId: string; leadWorktree: WorktreeRecord; selectedCheckpointIds: string[];
    workerGeneration: string; idempotencyKey: string;
  }): Promise<IntegrateCheckpointResult>;
}
```

The service loads checkpoint records by ID, rejects task mismatches/duplicates/moving refs, invokes only `GitManager`, and appends `checkpoint.integrated` or `integration.conflict` events with OIDs and bounded file names.

- [ ] **Step 5: Add parallel implementation and unresolved-divergence cases**

Test a collaborator implementation from the recorded base, reviewer-only output with no file mutation, Lead selection of zero/one/multiple checkpoints, checkpoint order, a ref changed externally, a checkpoint belonging to another task, two simultaneous round requests with the same/different idempotency keys, and round-2 unresolved findings. Assert the Inspector-ready result retains conflicts and Agent disagreement instead of treating them as success.

- [ ] **Step 6: Run collaboration/Git integration tests and regressions**

Run: `pnpm test:integration -- tests/integration/tasks/collaboration-rounds.test.ts tests/integration/git/lead-integration.test.ts tests/integration/git/git-manager-checkpoints.test.ts && pnpm test:unit && pnpm typecheck`

Expected: all tests PASS; initial automatic collaboration stops at two rounds, human revision preserves the count, a new receipt permits only its explicit increment, and every Git mutation is observed through GitManager.

- [ ] **Step 7: Commit collaboration and Lead integration**

```bash
git add src/worker/tasks/collaboration-coordinator.ts src/worker/git/integration-service.ts src/worker/git/git-manager.ts src/worker/tasks/task-engine.ts tests/fixtures/task-engine.ts tests/integration/tasks/collaboration-rounds.test.ts tests/integration/git/lead-integration.test.ts
git commit -m "feat(tasks): coordinate bounded cross-review and integration"
```

### Task 9: Journaled Test Commands and a Hash-Verified Integration Candidate

**Files:**
- Create: `src/worker/operations/journaled-process-runner.ts`
- Create: `src/worker/approvals/approved-command-runner.ts`
- Create: `src/worker/git/candidate-hasher.ts`
- Create: `src/worker/tasks/candidate-service.ts`
- Modify: `src/worker/git/git-manager.ts`
- Modify: `src/worker/git/git-artifact-repository.ts`
- Modify: `tests/fixtures/task-engine.ts`
- Test: `tests/unit/git/candidate-hasher.test.ts`
- Test: `tests/integration/tasks/candidate-verification.test.ts`
- Test: `tests/integration/operations/journaled-process-runner.test.ts`

**Interfaces:**
- Consumes: integrated Lead worktree, task capability receipt, worker-owned command catalog, `execFile`/process-group supervision, operation journal, Git read/lock/mutator APIs, canonical hashing, artifact repository, and EventStore.
- Produces: `JournaledProcessRunner.run/cancel`, `ApprovedCommandRunner.run`, `CandidateHasher.diffHash/testSetHash`, `GitManager.protectCandidate`, and `CandidateService.buildVerifiedCandidate` with immutable candidate ref, exact diff hash, test-set hash, summary, risks, and unresolved disagreements.

Extend `tests/fixtures/task-engine.ts` with `createCandidateFixture()` returning the registered command catalog, candidate service, repository/Git adapters, generation UUID, artifact repositories, and cleanup. Keep `testResult(overrides)` as a fully defined local factory in `candidate-hasher.test.ts`.

- [ ] **Step 1: Write failing deterministic hash and command-boundary tests**

```ts
// tests/unit/git/candidate-hasher.test.ts
import { expect, it } from 'vitest';
import { CandidateHasher } from '../../../src/worker/git/candidate-hasher';

it('hashes raw diff bytes and order-independent normalized test records', () => {
  const hasher = new CandidateHasher();
  expect(hasher.diffHash(Buffer.from([0, 255, 10]))).toBe(
    'sha256:712450d3c4a79eea9509e75dc1dacdeff58034df538536cfae2da882bd8a0c50',
  );
  const a = testResult({ commandId: 'a', exitCode: 0 });
  const b = testResult({ commandId: 'b', exitCode: 1 });
  expect(hasher.testSetHash([b, a])).toBe(hasher.testSetHash([a, b]));
  expect(hasher.testSetHash([a, b])).not.toBe(hasher.testSetHash([a, testResult({ commandId: 'b', exitCode: 0 })]));
});
```

Compute the literal expected digest once with Node's `createHash('sha256')` and commit the actual value; the test must not derive its expected digest by calling the production helper.

```ts
// tests/integration/tasks/candidate-verification.test.ts
it('binds the candidate ref to full diff bytes and the exact executed test set', async () => {
  const fixture = await createCandidateFixture();
  const candidate = await fixture.candidates.buildVerifiedCandidate({
    taskId: 'task-1', selectedCheckpointIds: ['lead-revision'],
    testCommandIds: ['unit'], unresolved: [], workerGeneration: fixture.generation,
    idempotencyKey: 'candidate-1',
  });
  expect(candidate.immutableRef).toBe(`refs/branchestra/candidates/${candidate.id}`);
  expect(await fixture.git('rev-parse', candidate.immutableRef)).toBe(candidate.candidateOid);
  expect(candidate.diffHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(candidate.testSetHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(candidate.testResults).toEqual([expect.objectContaining({ commandId: 'unit', exitCode: 0 })]);
});
```

Add process tests proving a command is passed as one executable plus argv with `shell: false`, cwd is re-authorized, environment credentials are absent, output hashes are stable, timeout performs TERM then KILL on the tracked process group, and an unregistered command/class is rejected before intent or process creation.

- [ ] **Step 2: Run focused tests and verify command/candidate modules are absent**

Run: `pnpm test:unit -- tests/unit/git/candidate-hasher.test.ts && pnpm test:integration -- tests/integration/operations/journaled-process-runner.test.ts tests/integration/tasks/candidate-verification.test.ts`

Expected: FAIL because the process runner, approved command runner, candidate hasher, and candidate service do not exist.

- [ ] **Step 3: Implement journaled argv-only test execution**

```ts
// src/worker/operations/journaled-process-runner.ts
export interface ProcessCommand {
  commandId: string;
  commandClass: 'build' | 'test' | 'lint' | 'format';
  executableRealpath: string;
  argv: string[];
  cwdRealpath: string;
  timeoutMs: number;
}
export interface ProcessExecutionResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
  durationMs: number;
}
export class JournaledProcessRunner {
  run(input: {
    projectId: string; taskId: string; commonDirRealpath: string; command: ProcessCommand;
    workerGeneration: string; idempotencyKey: string;
  }): Promise<ProcessExecutionResult>;
  cancel(operationId: string, deadlineMs: number): Promise<void>;
}
```

Record expected executable realpath, argv, cwd, start identity, and hashes of the controlled environment before `execFile`. Invoke `execFile(executableRealpath, argv, { cwd, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', CI: '1' }, shell: false, detached: true, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })`. Track PID plus executable/start identity; cancellation sends TERM to the verified process group, waits the bounded deadline, then KILLs that same verified group. Observe exit code/output/duration and complete the journal before returning. Never inherit API keys, auth tokens, custom endpoints, package-manager credentials, `NODE_OPTIONS`, or the full worker environment.

- [ ] **Step 4: Gate commands through a worker-owned catalog and task receipt**

```ts
// src/worker/approvals/approved-command-runner.ts
export interface RegisteredProjectCommand extends ProcessCommand {
  displayName: string;
}
export interface ProjectCommandCatalog {
  get(projectId: string, commandId: string): RegisteredProjectCommand | null;
}
export class ApprovedCommandRunner {
  run(input: {
    projectId: string; taskId: string; commandId: string; receipt: ApprovalReceipt;
    guard: WorkspacePathGuard; commonDirRealpath: string; workerGeneration: string;
    idempotencyKey: string;
  }): Promise<TestResultRecord>;
}
```

Load commands by ID from the worker-owned catalog; Provider events may request only an ID. Revalidate receipt generation policy, command class membership, executable absolute realpath, cwd through `assertChildCwd`, timeout `<= scope.maxRunMs`, and `toolNetwork` enforcement profile before recording intent. Hash stdout/stderr separately and persist the result with a `room-event:<eventId>` log reference; never place raw output in a hash or approval tuple.

- [ ] **Step 5: Implement canonical candidate hashes and create-only refs**

```ts
// src/worker/git/candidate-hasher.ts
export class CandidateHasher {
  diffHash(diffBytes: Buffer): `sha256:${string}`;
  testSetHash(results: readonly TestResultRecord[]): `sha256:${string}`;
}
```

`testSetHash` sorts by `commandId` and hashes canonical JSON containing exactly `commandId`, `executableRealpath`, `argv`, `exitCode`, `stdoutHash`, and `stderrHash`. It excludes timestamps, durations, database IDs, and log locations.

Add to `GitManager`:

```ts
protectCandidate(input: {
  projectId: string; taskId: string; candidateId: string; leadWorktree: WorktreeRecord;
  expectedHeadOid: string; workerGeneration: string; idempotencyKey: string;
}): Promise<{ candidateOid: string; immutableRef: string }>;
```

Under the repository lock, verify Lead `HEAD === expectedHeadOid`, run create-only `git update-ref refs/branchestra/candidates/<candidateId> <expectedHeadOid> <zeroOid>`, accept an existing ref only at the same OID, observe it, and never move it.

- [ ] **Step 6: Build and persist the verified candidate atomically after external observations**

```ts
// src/worker/tasks/candidate-service.ts
export class CandidateService {
  buildVerifiedCandidate(input: {
    taskId: string; selectedCheckpointIds: string[]; testCommandIds: string[];
    unresolved: Array<{ source: 'claude' | 'codex' | 'git' | 'test'; summary: string }>;
    workerGeneration: string; idempotencyKey: string;
  }): Promise<IntegrationCandidate>;
}
```

Load the Lead worktree and current `HEAD`; protect the candidate ref; run only approved catalog commands; obtain raw `git diff --binary --full-index <baseOid> <candidateOid>` bytes plus a bounded numstat summary; compute both hashes; then insert `test_results`, `integration_candidates`, and `candidate_checkpoints` in one SQLite transaction. Transition `Working|Checkpoint|Revision|Review2 -> Candidate -> HumanApproval` and append `test.completed`, `candidate.created`, and `approval.requested` events. Test failure remains visible as `verificationStatus: 'failed'`; it does not falsify or omit the result, and final user approval still binds that exact failing test set.

- [ ] **Step 7: Add mutation and hash-change cases**

Test binary files, filenames with spaces/newlines, empty diffs, reordered test execution, one changed exit code, one changed output hash, failed tests, a candidate ref pre-created at another OID, a Provider request for an unknown command, timeout, cancellation, and a worktree symlink cwd. Assert each content/test change changes the corresponding hash and no raw filename/output is interpreted as a shell fragment.

- [ ] **Step 8: Run candidate, process, Git, and type tests**

Run: `pnpm test:unit -- tests/unit/git/candidate-hasher.test.ts && pnpm test:integration -- tests/integration/operations/journaled-process-runner.test.ts tests/integration/tasks/candidate-verification.test.ts tests/integration/git/lead-integration.test.ts && pnpm typecheck`

Expected: all tests PASS; candidate/test refs and hashes are deterministic, command execution is argv-only and scoped, and failed test evidence remains part of the candidate.

- [ ] **Step 9: Commit verified candidate generation**

```bash
git add src/worker/operations/journaled-process-runner.ts src/worker/approvals/approved-command-runner.ts src/worker/git/candidate-hasher.ts src/worker/tasks/candidate-service.ts src/worker/git/git-manager.ts src/worker/git/git-artifact-repository.ts tests/fixtures/task-engine.ts tests/unit/git/candidate-hasher.test.ts tests/integration/tasks/candidate-verification.test.ts tests/integration/operations/journaled-process-runner.test.ts
git commit -m "feat(tasks): build hash-verified integration candidates"
```

### Task 10: Immutable Final Approval Tuple and Invalidation

**Files:**
- Create: `src/worker/approvals/final-approval-service.ts`
- Modify: `src/worker/approvals/approval-service.ts`
- Modify: `src/worker/tasks/task-service.ts`
- Modify: `src/worker/protocol/worker-router.ts`
- Modify: `tests/fixtures/task-engine.ts`
- Test: `tests/unit/approvals/final-approval-service.test.ts`
- Test: `tests/integration/tasks/final-approval.test.ts`

**Interfaces:**
- Consumes: `IntegrationCandidate`, candidate immutable ref, `FinalApprovalTuple`, canonical hash, `ApprovalRepository`, `TaskRepository`, `GitReadService`, worker generation, and typed final-approval command.
- Produces: `FinalApprovalService.currentTuple/request/approve/assertCurrentlyValid/invalidate`, an immutable `final_merge` receipt, and a `Merging` transition only when the displayed/current tuples are identical.

Extend `tests/fixtures/task-engine.ts` with `finalApprovalFixture(tuple)` and its typed `approve`, `setCurrent`, `task`, `generation`, and service fields; no unit test accesses hidden mutable globals.

- [ ] **Step 1: Write a failing five-field invalidation matrix**

```ts
// tests/unit/approvals/final-approval-service.test.ts
import { describe, expect, it } from 'vitest';

describe('FinalApprovalService', () => {
  const original = {
    targetRef: 'refs/heads/main', baseOid: 'a'.repeat(40), candidateOid: 'b'.repeat(40),
    diffHash: `sha256:${'c'.repeat(64)}`, testSetHash: `sha256:${'d'.repeat(64)}`,
  } as const;

  it.each(['targetRef', 'baseOid', 'candidateOid', 'diffHash', 'testSetHash'] as const)(
    'invalidates when %s changes', async (field) => {
      const fixture = finalApprovalFixture(original);
      const receipt = await fixture.approve(original);
      fixture.setCurrent({ ...original, [field]: field === 'targetRef' ? 'refs/heads/other' : `${original[field]}changed` });
      await expect(fixture.service.assertCurrentlyValid(receipt.id, fixture.generation))
        .rejects.toThrow(`FINAL_APPROVAL_${field.toUpperCase()}_MISMATCH`);
      expect(fixture.task().state).toBe('HumanApproval');
    },
  );
});
```

Add tests for a stale displayed tuple, receipt hash mismatch, receipt belonging to another task, rejected receipt, generation UUID mismatch, candidate ref mismatch, duplicate approval idempotency, and exact tuple success.

- [ ] **Step 2: Run approval tests and verify the service is absent**

Run: `pnpm test:unit -- tests/unit/approvals/final-approval-service.test.ts && pnpm test:integration -- tests/integration/tasks/final-approval.test.ts`

Expected: FAIL because `final-approval-service` and its typed command handler do not exist.

- [ ] **Step 3: Implement exact tuple calculation and immutable receipt creation**

```ts
// src/worker/approvals/final-approval-service.ts
export class FinalApprovalService {
  currentTuple(taskId: string): Promise<FinalApprovalTuple>;
  request(taskId: string, idempotencyKey: string): Promise<ApprovalRequest>;
  approve(input: {
    taskId: string; approvalRequestId: string; displayed: FinalApprovalTuple;
    workerGeneration: string; idempotencyKey: string;
  }): Promise<ApprovalReceipt>;
  assertCurrentlyValid(approvalId: string, workerGeneration: string): Promise<{ task: TaskRecord; candidate: IntegrationCandidate; receipt: ApprovalReceipt }>;
  invalidate(taskId: string, approvalId: string, reason: string, idempotencyKey: string): Promise<TaskRecord>;
}
```

`currentTuple` loads `targetRef`/recorded base from the task, re-reads the candidate immutable ref OID through Git, recomputes raw diff bytes/hash, and recomputes `testSetHash` from persisted normalized test records. `request` persists a pending `ApprovalRequest` containing that tuple/hash. `approve` reloads that request, compares every displayed field to a freshly computed tuple, hashes canonical tuple JSON, atomically decides the request and stores a non-restart-surviving `final_merge` receipt with the current generation UUID, appends `approval.decided`, and transitions `HumanApproval -> Merging` only after persistence.

`assertCurrentlyValid` requires approved decision, exact task, exact scope/hash, current generation UUID, candidate immutable ref, target ref, base OID, diff hash, and test-set hash. On any mismatch it calls `invalidate`, appends the field-specific reason, and moves `Merging` back to `HumanApproval` (or keeps `HumanApproval`) without Git mutation.

- [ ] **Step 4: Register only the structured final-approval handler**

The `task.approveFinalMerge` handler takes all five tuple fields plus task/approval-request IDs from the trusted Inspector model, calls `FinalApprovalService.approve`, passes the returned receipt ID directly to `MergeService.mergeApprovedCandidate`, and returns the updated `TaskInspectorModel`. Provider messages, Markdown links, and generic room events never invoke this handler. A repeated envelope is handled by Milestone 1 durable dedupe and returns the same receipt/outcome.

- [ ] **Step 5: Run the invalidation matrix, integration tests, and type checking**

Run: `pnpm test:unit -- tests/unit/approvals/final-approval-service.test.ts && pnpm test:integration -- tests/integration/tasks/final-approval.test.ts && pnpm typecheck`

Expected: all tests PASS; changing any one of the five values invalidates the old receipt and no invalidation path calls Git mutation.

- [ ] **Step 6: Commit immutable final approval**

```bash
git add src/worker/approvals/final-approval-service.ts src/worker/approvals/approval-service.ts src/worker/tasks/task-service.ts src/worker/protocol/worker-router.ts tests/fixtures/task-engine.ts tests/unit/approvals/final-approval-service.test.ts tests/integration/tasks/final-approval.test.ts
git commit -m "feat(approvals): bind merge consent to immutable inputs"
```

### Task 11: Checkout-Owner-Aware ff-only Merge and Unchecked-Ref CAS

**Files:**
- Create: `src/worker/git/merge-service.ts`
- Modify: `src/worker/git/git-manager.ts`
- Modify: `src/worker/approvals/final-approval-service.ts`
- Modify: `tests/fixtures/task-engine.ts`
- Test: `tests/integration/git/final-merge.test.ts`
- Test: `tests/integration/git/external-race.test.ts`

**Interfaces:**
- Consumes: currently valid final receipt, `GitReadService.listWorktrees/status`, `RepositoryLock`, journal, `GitCommandRunner`, task/candidate repositories, and immutable candidate ref.
- Produces: `MergeService.mergeApprovedCandidate`, `GitManager.fastForwardCheckedOutOwner`, `GitManager.compareAndSwapUnownedRef`, `MergeOutcome`, and `Completed` or invalidated `HumanApproval` transition.

Extend `tests/fixtures/task-engine.ts` with `createFinalMergeFixture({ targetCheckedOut, dirty })`; return the receipt/candidate, real owner paths, injectable Git runner wrapper, operation/task repositories, exact byte snapshots, and cleanup.

- [ ] **Step 1: Write failing merge-mode, dirty-owner, and external-race tests**

```ts
// tests/integration/git/final-merge.test.ts
it('fast-forwards the real clean checkout owner with hooks disabled', async () => {
  const fixture = await createFinalMergeFixture({ targetCheckedOut: true, dirty: false });
  const result = await fixture.merge.mergeApprovedCandidate({
    taskId: 'task-1', approvalId: fixture.approval.id,
    workerGeneration: fixture.generation, idempotencyKey: 'merge-1',
  });
  expect(result).toMatchObject({ outcome: 'completed', mode: 'checked_out_ff_only' });
  expect(await fixture.targetOid()).toBe(fixture.candidate.candidateOid);
  expect(await fixture.ownerHeadOid()).toBe(fixture.candidate.candidateOid);
  expect(await fixture.hookSentinelExists()).toBe(false);
});

it('stops on a dirty checkout owner without stash/reset/clean', async () => {
  const fixture = await createFinalMergeFixture({ targetCheckedOut: true, dirty: true });
  const before = await fixture.ownerBytes();
  await expect(fixture.merge.mergeApprovedCandidate({
    taskId: 'task-1', approvalId: fixture.approval.id,
    workerGeneration: fixture.generation, idempotencyKey: 'merge-dirty',
  })).rejects.toThrow('TARGET_WORKTREE_DIRTY');
  expect(await fixture.ownerBytes()).toEqual(before);
  expect(fixture.mutatingArgv()).not.toEqual(expect.arrayContaining(['stash', 'reset', 'clean', 'checkout']));
});
```

```ts
// tests/integration/git/external-race.test.ts
it('loses an unowned update-ref CAS race and returns to HumanApproval', async () => {
  const fixture = await createFinalMergeFixture({ targetCheckedOut: false, dirty: false });
  fixture.gitRunner.beforeNextUpdateRef(async () => fixture.advanceTargetExternally());
  await expect(fixture.merge.mergeApprovedCandidate({
    taskId: 'task-1', approvalId: fixture.approval.id,
    workerGeneration: fixture.generation, idempotencyKey: 'merge-race',
  })).rejects.toThrow('TARGET_REF_CAS_FAILED');
  expect(fixture.tasks.getRequired('task-1').state).toBe('HumanApproval');
  expect(await fixture.targetOid()).toBe(fixture.externalOid);
  expect(fixture.operations.last().status).toBe('needs_attention');
});
```

The race fixture wraps `GitCommandRunner` and intercepts the exact `update-ref` argv; production code contains no test hook.

- [ ] **Step 2: Run merge tests and verify the merge service is absent**

Run: `pnpm test:integration -- tests/integration/git/final-merge.test.ts tests/integration/git/external-race.test.ts`

Expected: FAIL because `merge-service` and final GitManager merge methods do not exist.

- [ ] **Step 3: Add only the two permitted final mutation methods**

```ts
// Add to src/worker/git/git-manager.ts
fastForwardCheckedOutOwner(input: {
  projectId: string; taskId: string; ownerWorktreeRealpath: string; targetRef: string;
  baseOid: string; candidateOid: string; commonDirRealpath: string;
  workerGeneration: string; idempotencyKey: string;
}): Promise<{ mode: 'checked_out_ff_only'; targetOid: string }>;
compareAndSwapUnownedRef(input: {
  projectId: string; taskId: string; repositoryRootRealpath: string; targetRef: string;
  baseOid: string; candidateOid: string; commonDirRealpath: string;
  workerGeneration: string; idempotencyKey: string;
}): Promise<{ mode: 'unowned_update_ref_cas'; targetOid: string }>;
```

Both methods acquire the repository lock, record intent, re-read the target/candidate refs and approval tuple inside the lock, and stop before mutation on any mismatch. Checked-out mode identifies the actual owner from porcelain-`-z` worktree data, validates canonical path/common dir, requires empty porcelain-v2 status and no merge/cherry-pick/rebase/revert/bisect state, then runs `git merge --ff-only <candidateOid>` in that owner with hooks disabled. Observe target ref, owner `HEAD`, index, and worktree before completion.

Unowned mode verifies no worktree owns `targetRef`, then runs exactly `git update-ref <targetRef> <candidateOid> <baseOid>`. A non-zero CAS exit is observed as conflict and never retried with a new base. Observe `targetRef === candidateOid` before completion.

- [ ] **Step 4: Implement merge orchestration and post-mutation observation**

```ts
// src/worker/git/merge-service.ts
export type MergeOutcome = {
  outcome: 'completed';
  mode: 'checked_out_ff_only' | 'unowned_update_ref_cas';
  targetRef: string;
  previousOid: string;
  targetOid: string;
};
export class MergeService {
  mergeApprovedCandidate(input: {
    taskId: string; approvalId: string; workerGeneration: string; idempotencyKey: string;
  }): Promise<MergeOutcome>;
}
```

Call `FinalApprovalService.assertCurrentlyValid` before and again inside the locked Git method. Choose mode solely from `listWorktrees`. After observed success, append `merge.completed` and transition `Merging -> Completed` in one database transaction. If validation, ff-only, CAS, dirty state, in-progress operation, or post-observation fails, record the exact actual state, invalidate the receipt, and return to `HumanApproval`; never automatically replay, stash, force, reset, or remove.

- [ ] **Step 5: Cover owner and divergence edge cases**

Add tests for the main worktree owner, a linked worktree owner, dirty staged/unstaged/untracked files, merge/cherry-pick/rebase state, detached worktrees, target checked out twice (fail closed), target advanced before lock, candidate ref externally moved, ff-only ancestry failure, CAS success, duplicate completed request, hook suppression, and app-local merge identity. At task creation, assert a dirty main worktree only produces `baseSnapshotWarning: 'main_worktree_dirty'`; Agent work still starts from clean recorded `HEAD`, and final merge remains blocked until the owner is clean.

- [ ] **Step 6: Run merge, approval, and Git regression tests**

Run: `pnpm test:integration -- tests/integration/git/final-merge.test.ts tests/integration/git/external-race.test.ts tests/integration/tasks/final-approval.test.ts && pnpm typecheck`

Expected: all tests PASS; checked-out refs use clean-owner ff-only, unowned refs use old-OID CAS, and every race or dirty state preserves user content and returns to review.

- [ ] **Step 7: Commit final Git integration**

```bash
git add src/worker/git/merge-service.ts src/worker/git/git-manager.ts src/worker/approvals/final-approval-service.ts tests/fixtures/task-engine.ts tests/integration/git/final-merge.test.ts tests/integration/git/external-race.test.ts
git commit -m "feat(git): merge approved candidates with race guards"
```

### Task 12: Startup Reconciliation, External-State Observation, and Explicit Resume

**Files:**
- Create: `src/worker/git/git-operation-reconciler.ts`
- Create: `src/worker/tasks/recovery-coordinator.ts`
- Modify: `src/worker/tasks/task-engine.ts`
- Modify: `src/worker/runtime.ts`
- Modify: `src/worker/protocol/worker-router.ts`
- Modify: `tests/fixtures/task-engine.ts`
- Test: `tests/integration/operations/git-journal-recovery.test.ts`
- Test: `tests/integration/tasks/task-restart-recovery.test.ts`

**Interfaces:**
- Consumes: non-terminal tasks, incomplete operation records, current worker generation UUID, Git actual state, final approval service, `TaskProviderPort.resumeRun`, persisted run session/context, and Milestone 1 worker startup/lease.
- Produces: `GitOperationReconciler.observe`, `RecoveryCoordinator.preview/resolve`, typed recovery commands/events, `Interrupted -> Reconciling -> recorded safe phase|Completed|HumanApproval|Cancelled`, and no automatic side-effect replay.

Extend `tests/fixtures/task-engine.ts` with `createCrashedCheckpointFixture(boundary)` and `createInterruptedMergeFixture(targetState)`; each creates the exact database/journal/Git boundary before returning recovery services and read-only mutation counters.

- [ ] **Step 1: Write failing crash-boundary and interrupted-merge tests**

```ts
// tests/integration/operations/git-journal-recovery.test.ts
import { describe, expect, it } from 'vitest';

describe.each(['intent', 'executing', 'observed'] as const)('checkpoint crash after %s', (boundary) => {
  it('observes Git and returns a preview without replaying mutation', async () => {
    const fixture = await createCrashedCheckpointFixture(boundary);
    const beforeCalls = fixture.git.mutationCount();
    const preview = await fixture.recovery.preview('task-1');
    expect(fixture.git.mutationCount()).toBe(beforeCalls);
    expect(preview.operations[0]).toMatchObject({ operationType: 'checkpoint.ref.create' });
    expect(['not_applied', 'applied', 'uncertain']).toContain(preview.operations[0].outcome);
    expect(fixture.tasks.getRequired('task-1').state).toBe('Reconciling');
  });
});
```

```ts
// tests/integration/tasks/task-restart-recovery.test.ts
it.each([
  ['candidate already merged', 'candidate', 'Completed'],
  ['merge not applied', 'base', 'HumanApproval'],
  ['target changed elsewhere', 'external', 'HumanApproval'],
] as const)('reconciles interrupted Merging when %s', async (_label, targetState, expectedState) => {
  const fixture = await createInterruptedMergeFixture(targetState);
  const preview = await fixture.recovery.preview('task-1');
  expect(preview.recordedPhase).toBe('Merging');
  await fixture.recovery.resolve({ taskId: 'task-1', decision: 'keep_observed_state', selectedOperationIds: [], idempotencyKey: `resolve-${targetState}` });
  expect(fixture.tasks.getRequired('task-1').state).toBe(expectedState);
  expect(fixture.git.mutationCountDuringRecovery()).toBe(0);
});
```

Add cases for every journal boundary of worktree add, checkpoint commit/ref, cherry-pick, candidate ref, test process, checked-out ff-only, and unowned CAS. Include repository missing, worktree path moved, branch/ref changed, uncommitted diff retained, process identity mismatch, mock session resumable/unresumable, cancel-in-progress, and duplicate recovery resolution.

- [ ] **Step 2: Run recovery tests and verify reconcilers are absent**

Run: `pnpm test:integration -- tests/integration/operations/git-journal-recovery.test.ts tests/integration/tasks/task-restart-recovery.test.ts`

Expected: FAIL because `git-operation-reconciler` and `recovery-coordinator` do not exist and runtime does not expose recovery commands.

- [ ] **Step 3: Implement operation-specific read-only observation**

```ts
// src/worker/git/git-operation-reconciler.ts
export interface ReconciledOperation {
  operationId: string;
  operationType: string;
  outcome: 'not_applied' | 'applied' | 'conflict' | 'uncertain';
  expected: Record<string, unknown>;
  actual: Record<string, unknown>;
  safeResolution: 'mark_complete' | 'keep_pending' | 'human_attention';
}
export class GitOperationReconciler {
  observe(record: OperationRecord): Promise<ReconciledOperation>;
}
```

Switch exhaustively on operation types `workspace.write`, `worktree.add`, `checkpoint.commit`, `checkpoint.ref.create`, `checkpoint.integrate`, `checkpoint.integrate.continue`, `candidate.ref.create`, `test.process`, `merge.ff_only`, and `merge.update_ref_cas`. Each observer uses only read methods plus verified process identity. Examples: matching scoped file content hash or expected ref/OID/worktree is `applied`; all expected objects absent is `not_applied`; a different content hash/ref/OID/path is `conflict`; partial commit/index/process identity or inaccessible repository is `uncertain`. Unknown operation types are `uncertain`, never `not_applied`.

- [ ] **Step 4: Build an explicit recovery preview and resolution API**

```ts
// src/worker/tasks/recovery-coordinator.ts
export interface ResolveRecoveryInput {
  taskId: string;
  decision: 'resume_recorded_phase' | 'keep_observed_state' | 'cancel_and_retain';
  selectedOperationIds: string[];
  idempotencyKey: string;
}
export class RecoveryCoordinator {
  markInterruptedAfterGenerationChange(previousGeneration: string, currentGeneration: string): Promise<string[]>;
  preview(taskId: string): Promise<RecoveryPreview>;
  resolve(input: ResolveRecoveryInput): Promise<TaskRecord>;
}
```

On worker startup after the durable lease is acquired, invalidate pending sensitive receipts from older generation UUIDs, mark active runs interrupted, and apply process loss to non-terminal tasks that were not already interrupted. Do not invoke Provider/Git/process mutators. `preview` transitions `Interrupted -> Reconciling`, observes repository/worktrees/branches/checkpoints/dirty diff/provider session and each journal record, and appends a structured `task.recovery` event.

`resolve` requires an exact preview hash in the command payload (extend `ResolveRecoveryInput` and protocol with `previewHash`) and re-observes before acting. `cancel_and_retain` settles `Cancelled` without deletion. `resume_recorded_phase` may call mock `resumeRun` only after the user chooses and only for a persisted resumable session; otherwise create a new mock run with a recovery brief containing task scope, recorded phase, context hash, latest checkpoint, and current Git status. It does not replay a Provider prompt or shell/Git operation from the journal. `keep_observed_state` marks only `applied` operations complete; conflict/uncertain records stay `needs_attention`.

For interrupted `Merging`: target equals candidate and owner status is consistent -> record observation and `Completed`; target equals base -> invalidate old approval and `HumanApproval`; any other target/index/merge state -> `HumanApproval` with `needs_attention`. Never invoke merge during reconciliation.

- [ ] **Step 5: Wire reconciliation into worker startup and typed commands**

After Milestone 1's generation/lease handshake and migrations, construct one `RecoveryCoordinator` and call `markInterruptedAfterGenerationChange`. Register `task.recovery.preview` and `task.recovery.resolve` handlers. Startup may append interruption events but must not display a run as resumed until a resolve command succeeds. Ensure the runtime's `prepareQuit(deadline)` uses `TaskEngine.cancel(..., 'quit')`, journals observed status, and leaves incomplete tasks `Interrupted` when the deadline expires.

- [ ] **Step 6: Verify restart, external races, and no replay**

Run: `pnpm test:integration -- tests/integration/operations/git-journal-recovery.test.ts tests/integration/tasks/task-restart-recovery.test.ts tests/integration/git/external-race.test.ts && pnpm test:unit && pnpm typecheck`

Expected: all tests PASS; no preview mutates Git/process state, completed external effects are adopted, uncertain effects remain visible, collaboration counts persist, and interrupted merge is never replayed.

- [ ] **Step 7: Commit startup reconciliation and explicit resume**

```bash
git add src/worker/git/git-operation-reconciler.ts src/worker/tasks/recovery-coordinator.ts src/worker/tasks/task-engine.ts src/worker/runtime.ts src/worker/protocol/worker-router.ts tests/fixtures/task-engine.ts tests/integration/operations/git-journal-recovery.test.ts tests/integration/tasks/task-restart-recovery.test.ts
git commit -m "feat(tasks): reconcile interrupted work without side-effect replay"
```

### Task 13: Typed Task Commands and Task Inspector UI

**Files:**
- Create: `src/worker/tasks/task-command-handlers.ts`
- Create: `src/renderer/features/tasks/use-task-inspector.ts`
- Create: `src/renderer/features/tasks/task-inspector.tsx`
- Create: `src/renderer/features/tasks/approval-panel.tsx`
- Create: `src/renderer/features/tasks/candidate-panel.tsx`
- Create: `src/renderer/features/tasks/recovery-panel.tsx`
- Modify: `src/shared/contracts/domain.ts`
- Modify: `src/shared/contracts/protocol.ts`
- Modify: `src/worker/storage/event-store.ts`
- Modify: `src/worker/runtime.ts`
- Modify: `src/worker/protocol/worker-router.ts`
- Modify: `src/renderer/state/timeline-store.ts`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/components/Timeline.tsx`
- Modify: `src/renderer/components/Inspector.tsx`
- Modify: `tests/integration/event-store.test.ts`
- Modify: `tests/unit/contracts/task-protocol.test.ts`
- Modify: `tests/unit/renderer-gateway.test.ts`
- Modify: `tests/unit/preload-api.test.ts`
- Modify: `tests/unit/timeline-store.test.ts`
- Test: `tests/unit/tasks/task-command-handlers.test.ts`
- Test: `tests/unit/renderer/task-inspector.test.tsx`

**Interfaces:**
- Consumes: Milestone 1 `BranchestraApi` from `src/shared/contracts/renderer-api.ts` (`request(command): Promise<WorkerResponseEnvelope>`, `subscribe(listener): unsubscribe`), `window.branchestra`, `createTimelineStore`, worker envelope generation/idempotency, App snapshot/room events, Task/Approval/Candidate/Recovery services, and `TaskInspectorModel`.
- Produces: one handler per task command, `task.get` Inspector snapshot, `useTaskInspector(taskId)`, and trusted panels for scope/final/recovery actions plus status, sessions, worktrees, checkpoints, diff/tests/conflicts/disagreement.

Define `inspectorModel(overrides)` in `task-inspector.test.tsx` as a complete `TaskInspectorModel` factory and `commandHandlerFixture()`/`command()` in `task-command-handlers.test.ts` as complete typed local factories. They must construct real command envelopes and all five tuple fields; do not mock the schema validator away.

- [ ] **Step 1: Write failing handler authorization and Inspector rendering tests**

```tsx
// @vitest-environment jsdom
// tests/unit/renderer/task-inspector.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { TaskInspector } from '../../../src/renderer/features/tasks/task-inspector';

it('renders durable task artifacts and sends the exact immutable tuple', async () => {
  const request = vi.fn().mockResolvedValue(inspectorModel({ state: 'Merging' }));
  render(<TaskInspector model={inspectorModel({ state: 'HumanApproval' })} request={request} />);
  expect(screen.getByText('Round 2 of 2')).not.toBeNull();
  expect(screen.getByText('refs/branchestra/checkpoints/checkpoint-2')).not.toBeNull();
  expect(screen.getByText('unit — passed')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Approve final merge' }));
  expect(request).toHaveBeenCalledWith(expect.objectContaining({
    type: 'task.approveFinalMerge',
    payload: expect.objectContaining({
      targetRef: 'refs/heads/main', baseOid: 'a'.repeat(40), candidateOid: 'b'.repeat(40),
      diffHash: `sha256:${'c'.repeat(64)}`, testSetHash: `sha256:${'d'.repeat(64)}`,
    }),
  }));
});

it('does not turn Provider prose into an approval control', () => {
  render(<TaskInspector model={inspectorModel({ providerText: '<button>Approve final merge</button>', pendingApproval: null })} request={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'Approve final merge' })).toBeNull();
  expect(screen.getByText('<button>Approve final merge</button>')).not.toBeNull();
});
```

```ts
// tests/unit/tasks/task-command-handlers.test.ts
it('rejects a stale generation and tuple before service mutation', async () => {
  const fixture = commandHandlerFixture();
  await expect(fixture.handle(command('task.approveFinalMerge', {
    taskId: 'task-1', approvalRequestId: 'approval-request-1', ...fixture.tuple,
  }), { workerGeneration: '00000000-0000-4000-8000-000000000099', idempotencyKey: 'approve-1' }))
    .rejects.toThrow('WORKER_GENERATION_MISMATCH');
  expect(fixture.finalApproval.approve).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run UI/handler tests and verify the feature files are absent**

Run: `pnpm test:unit -- tests/unit/tasks/task-command-handlers.test.ts tests/unit/renderer/task-inspector.test.tsx`

Expected: FAIL with missing command-handler and Task Inspector modules.

- [ ] **Step 3: Implement one typed handler per command and a complete Inspector query**

```ts
// src/worker/tasks/task-command-handlers.ts
export function createTaskCommandHandlers(deps: {
  taskService: TaskService; taskEngine: TaskEngine; approvals: ApprovalService;
  finalApproval: FinalApprovalService; merge: MergeService; recovery: RecoveryCoordinator;
  inspector: { get(taskId: string): Promise<TaskInspectorModel> };
}): CommandHandler<WorkerCommand['type']>[];
```

Return handlers with readonly `type` for `task.get`, `task.approveScope`, `task.cancel`, `task.requestRevision`, `task.grantAdditionalRound`, `task.approveFinalMerge`, `task.recovery.preview`, and `task.recovery.resolve`. Each checks context generation UUID, calls exactly one service entry point, and returns a fresh Inspector model. Register this array in the existing `createWorkerRouter({ workerGeneration, handlers })`; do not add a renderer-to-shell, renderer-to-Git, or generic invoke handler.

The Inspector query assembles task, scope receipt, active runs, worktrees, checkpoints, candidate/test records, pending structured approval, and recovery preview from repositories. Perform the snapshot seam as one atomic change: add the required `tasks: TaskInspectorModel[]` field to `AppSnapshotSchema` and its inferred type; inject a synchronous `TaskSnapshotSource.list(): TaskInspectorModel[]` into `createEventStore`; make `EventStore.snapshot()` produce that field; wire the source in `src/worker/runtime.ts`; update the event-store, protocol, Renderer-gateway, preload, and timeline fixtures to emit strict schema-valid snapshots; and hydrate `snapshot.tasks` in the Renderer before accepting later task events. There is no optional transition state and no `activeTasks` alias. Add exact structured room-event payloads so replay updates the same model after restart.

- [ ] **Step 4: Implement the subscription hook without in-memory workflow authority**

```ts
// src/renderer/features/tasks/use-task-inspector.ts
export function useTaskInspector(api: BranchestraApi, taskId: string | null): {
  model: TaskInspectorModel | null;
  pending: boolean;
  error: string | null;
  request(command: WorkerCommand): Promise<TaskInspectorModel>;
};
```

The exact declaration is `useTaskInspector(api: BranchestraApi, taskId: string | null)`. On task selection, call typed `task.get`, unwrap `WorkerResponseEnvelope.payload` only after validating its task-inspector response discriminant, and subscribe through `api.subscribe` to Milestone 1 replayed room events. Refresh when an event's `taskId` matches. On generation change or cursor gap, discard the local model and request a new snapshot before applying later events. Do not infer state transitions from Provider text or optimistic button state.

- [ ] **Step 5: Implement the Inspector and trusted action panels**

`TaskInspector` renders scope, Lead, exact state, `Round <used> of <budget>`, human revision count, Provider sessions/cancel, canonical worktree paths, branch/base/current checkpoint, candidate diff summary, test pass/fail/output-log links, conflicts, unresolved Agent disagreement, pending approval, and recovery observations. Use plain text/React nodes for all Provider/repository strings; never use `dangerouslySetInnerHTML`.

`ApprovalPanel` renders buttons only when `pendingApproval.kind` is a trusted structured model value and sends the displayed scope hash/tuple. `CandidatePanel` sends all five tuple fields and disables merge when no current structured receipt exists. `RecoveryPanel` displays expected versus actual operation state and sends `previewHash`, decision, and selected operation IDs. All destructive-looking actions require a direct click; keyboard submission of chat text cannot trigger them.

- [ ] **Step 6: Mount the feature in the right column and test state variants**

Extend `createTimelineStore` with `selectedTaskId: string | null` and `selectTask(taskId: string | null): void`, have the existing `Timeline` selection call it, and modify the existing `App.tsx`/`components/Inspector.tsx` composition to invoke `useTaskInspector(window.branchestra, selectedTaskId)` in the right column. Add tests for no selection, AwaitingApproval, Working/cancel, two rounds, human revision, failed tests, conflict/unresolved findings, stale receipt, dirty-owner merge block, Interrupted recovery, Completed, malicious HTML/ANSI/filename text, and duplicate replayed events.

- [ ] **Step 7: Run UI, handler, protocol, and build checks**

Run: `pnpm test:unit -- tests/unit/tasks/task-command-handlers.test.ts tests/unit/renderer/task-inspector.test.tsx tests/unit/contracts/task-protocol.test.ts && pnpm typecheck && pnpm build`

Expected: all tests PASS, build succeeds, stale generation/tuple commands fail before mutation, and only structured approval data renders action controls.

- [ ] **Step 8: Commit typed commands and Task Inspector**

```bash
git add src/worker/tasks/task-command-handlers.ts src/renderer/features/tasks/use-task-inspector.ts src/renderer/features/tasks/task-inspector.tsx src/renderer/features/tasks/approval-panel.tsx src/renderer/features/tasks/candidate-panel.tsx src/renderer/features/tasks/recovery-panel.tsx src/shared/contracts/domain.ts src/shared/contracts/protocol.ts src/worker/storage/event-store.ts src/worker/runtime.ts src/worker/protocol/worker-router.ts src/renderer/state/timeline-store.ts src/renderer/App.tsx src/renderer/components/Timeline.tsx src/renderer/components/Inspector.tsx tests/integration/event-store.test.ts tests/unit/contracts/task-protocol.test.ts tests/unit/renderer-gateway.test.ts tests/unit/preload-api.test.ts tests/unit/timeline-store.test.ts tests/unit/tasks/task-command-handlers.test.ts tests/unit/renderer/task-inspector.test.tsx
git commit -m "feat(renderer): add trusted task inspector workflow"
```

### Task 14: Mock-Provider Electron E2E for Approval, Collaboration, Merge, and Restart

**Files:**
- Create: `e2e/support/branchestra-app.ts`
- Create: `e2e/task-engine.spec.ts`
- Create: `e2e/task-recovery.spec.ts`
- Create: `tests/fixtures/mock-provider/two-round-success.ts`
- Create: `tests/fixtures/mock-provider/interrupted-run.ts`
- Modify: `src/worker/runtime.ts`
- Modify: `src/worker/providers/mock-provider.ts`
- Test: `e2e/task-engine.spec.ts`
- Test: `e2e/task-recovery.spec.ts`

**Interfaces:**
- Consumes: Milestone 1 Electron build/E2E launcher, temp Git fixture, worker runtime factory, every Task Inspector command, shared user-data directory across relaunch, and deterministic mock scripts. It consumes no Provider SDK/CLI/executable/auth state.
- Produces: `launchBranchestraE2E`, guarded `mockProviderScenario` runtime injection, one full two-round/merge E2E, one interrupted/restart/recovery E2E, and end-to-end proof that cancellation preserves artifacts.

- [ ] **Step 1: Write the failing full workflow Electron test**

```ts
// e2e/task-engine.spec.ts
import { expect, test } from '@playwright/test';
import { createGitRepositoryFixture } from '../tests/fixtures/git-repository';
import { launchBranchestraE2E } from './support/branchestra-app';

test('mentions, approves, collaborates twice, verifies, and merges only after final approval', async () => {
  const repository = await createGitRepositoryFixture();
  const app = await launchBranchestraE2E({ scenario: 'two-round-success' });
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Add project' }).click();
  await app.chooseRepository(repository.root);
  await page.getByLabel('Message').fill('@Claude implement the greeting');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByTestId('task-state')).toHaveText('AwaitingApproval');
  expect(await repository.run(['rev-parse', 'refs/heads/main'])).toMatchObject({ stdout: `${repository.initialOid}\n` });
  await page.getByRole('button', { name: 'Approve task scope' }).click();
  await expect(page.getByText('Round 2 of 2')).toBeVisible();
  await expect(page.getByText('unit — passed')).toBeVisible();
  await expect(page.getByTestId('task-state')).toHaveText('HumanApproval');
  expect((await repository.run(['rev-parse', 'refs/heads/main'])).stdout.trim()).toBe(repository.initialOid);
  await page.getByRole('button', { name: 'Approve final merge' }).click();
  await expect(page.getByTestId('task-state')).toHaveText('Completed');
  expect((await repository.run(['show', 'refs/heads/main:greeting.txt'])).stdout).toBe('hello from both agents\n');
  await app.close();
  await repository.cleanup();
});
```

The fixture's mock script must make Lead write/checkpoint, Codex review round 1, Lead revise/checkpoint, Codex review round 2, request one registered test command, and finish. Assert timeline ordering for `approval.requested`, both reviewed checkpoint OIDs, `test.completed`, `candidate.created`, `approval.decided`, and `merge.completed`.

- [ ] **Step 2: Write the failing restart and cancellation E2E**

```ts
// e2e/task-recovery.spec.ts
test('relaunches into Interrupted, previews recovery, resumes explicitly, and retains cancellation output', async () => {
  const repository = await createGitRepositoryFixture();
  const first = await launchBranchestraE2E({ scenario: 'interrupted-run' });
  const page = await first.firstWindow();
  await createAndApproveTask(page, first, repository.root, '@Codex create partial.txt');
  await expect(page.getByText('partial.txt')).toBeVisible();
  const userDataDir = first.userDataDir;
  await first.crashWorkerForTest();
  await first.close();

  const second = await launchBranchestraE2E({ scenario: 'interrupted-run', userDataDir });
  const resumed = await second.firstWindow();
  await expect(resumed.getByTestId('task-state')).toHaveText('Interrupted');
  await resumed.getByRole('button', { name: 'Preview recovery' }).click();
  await expect(resumed.getByText('No side effects replayed')).toBeVisible();
  await resumed.getByRole('button', { name: 'Resume recorded phase' }).click();
  await resumed.getByRole('button', { name: 'Stop task' }).click();
  await expect(resumed.getByTestId('task-state')).toHaveText('Cancelled');
  expect(await second.readManagedWorktreeFile('partial.txt')).toBe('keep after restart\n');
  expect(await second.managedBranchExists()).toBe(true);
  await second.close();
  await repository.cleanup();
});
```

- [ ] **Step 3: Run E2E tests and verify the mock runtime seam/harness are absent**

Run: `pnpm build && pnpm test:e2e -- e2e/task-engine.spec.ts e2e/task-recovery.spec.ts`

Expected: FAIL because `launchBranchestraE2E`, named mock scenarios, and runtime injection are not implemented.

- [ ] **Step 4: Implement a production-inaccessible E2E mock seam**

```ts
// Add to src/worker/runtime.ts
export interface WorkerStartOptions {
  e2eMock?: {
    enabled: true;
    scenario: 'two-round-success' | 'interrupted-run';
  };
}
```

Honor `e2eMock` only when the Electron app is not packaged and the E2E build-time flag is true; otherwise throw `MOCK_PROVIDER_DISABLED`. When the property is absent, this milestone exposes no executable Provider and leaves task start health-gated. Map the two literal scenario names to compiled deterministic fixture steps and inject `MockProvider` into `TaskEngine`. Do not accept a script path, module path, command, executable, JSON payload, or arbitrary Provider event from Renderer IPC/environment. Production mode has no mock selection in UI and this milestone does not construct a real adapter.

- [ ] **Step 5: Implement the Electron harness with explicit paths and lifecycle controls**

```ts
// e2e/support/branchestra-app.ts
export interface LaunchBranchestraE2EOptions {
  scenario: 'two-round-success' | 'interrupted-run';
  userDataDir?: string;
}
export interface BranchestraE2EApp {
  userDataDir: string;
  firstWindow(): Promise<Page>;
  chooseRepository(path: string): Promise<void>;
  crashWorkerForTest(): Promise<void>;
  readManagedWorktreeFile(relativePath: string): Promise<string>;
  managedBranchExists(): Promise<boolean>;
  close(): Promise<void>;
}
export function launchBranchestraE2E(options: LaunchBranchestraE2EOptions): Promise<BranchestraE2EApp>;
export async function createAndApproveTask(
  page: Page,
  app: BranchestraE2EApp,
  repositoryRoot: string,
  message: `@Claude ${string}` | `@Codex ${string}`,
): Promise<void>;
```

Launch the built Electron main entry through Playwright `_electron.launch` with an absolute temp user-data directory and literal scenario. Implement repository choice through the existing M1 test dialog seam, and worker crash through a Main-only E2E test hook that is compiled out/disabled in packaged builds and accepts no PID or command. `createAndApproveTask` calls `chooseRepository`, fills the Message textbox, clicks Send, waits for `AwaitingApproval`, clicks the structured scope button, and waits for `Preparing|Working`; it does not bypass IPC. `close` waits for the quit handshake and fails the test on unexpected worker stderr.

- [ ] **Step 6: Add security and race assertions to the vertical slice**

Within the full-flow test, inject mock Provider text containing a fake approval button, raw HTML, a navigation link, ANSI escapes, and a filename containing shell metacharacters. Assert none creates a trusted action, navigation, new window, renderer Node/filesystem access, or extra IPC. Send a duplicate final command and assert one merge event. Advance the target ref externally before a second candidate approval and assert the UI returns to `HumanApproval` with the new base/race explanation.

- [ ] **Step 7: Run all Milestone 2 verification commands**

Run: `pnpm test:unit && pnpm test:integration && pnpm typecheck && pnpm build && pnpm test:e2e -- e2e/task-engine.spec.ts e2e/task-recovery.spec.ts`

Expected: every command exits 0; the Electron tests use only `MockProvider`, the base branch changes only after the exact final tuple is approved, restart never replays a side effect, and cancellation preserves worktrees/branches/content.

- [ ] **Step 8: Commit the mock-provider Electron vertical slice**

```bash
git add e2e/support/branchestra-app.ts e2e/task-engine.spec.ts e2e/task-recovery.spec.ts tests/fixtures/mock-provider/two-round-success.ts tests/fixtures/mock-provider/interrupted-run.ts src/worker/runtime.ts src/worker/providers/mock-provider.ts
git commit -m "test(e2e): verify mock task collaboration and recovery"
```

## Requirement-to-Test Traceability

| Milestone 2 requirement | Primary task/tests |
|---|---|
| Exhaustive non-terminal cancel/fail/process loss; recorded phase | Task 1 state table; Task 12 restart tests |
| Two automatic rounds; human revision; explicit extra budget | Tasks 1 and 8; `collaboration-rounds.test.ts` |
| `@Claude`/`@Codex` creates approval-first task | Task 5; `task-approval.test.ts` |
| Durable capability receipt and generation policy | Tasks 2, 5, and 10 approval tests |
| Intent/execute/observe/complete journal and repository lock | Tasks 2–3; operation and recovery tests |
| Sole Git mutator; per-Agent branch/worktree; no Provider Git mutation | Tasks 4 and 6; boundary/worktree tests |
| realpath/traversal/symlink/common-dir guard | Tasks 4–5; negative path/write tests |
| Immutable checkpoint/candidate refs | Tasks 6 and 9; checkpoint/candidate tests |
| Mock run/cancel/process loss and retained artifacts | Task 7; run/cancellation tests |
| Cross-review, conflicts, Lead integration | Task 8; collaboration/integration tests |
| Diff/test hashes and five-field final receipt | Tasks 9–10; hash/invalidation matrix |
| Dirty checkout owner, ff-only, unowned CAS, external race | Task 11; final-merge/race tests |
| Crash reconciliation without replay | Task 12; every journal-boundary matrix |
| Inspector, trusted controls, replay/generation handling | Task 13; handler/renderer tests |
| Full mock-provider Electron workflow and restart | Task 14 E2E |

After Task 14, the implementation is ready for the separate real-Provider adapter milestone. That later milestone must implement `TaskProviderPort` and reuse these task, approval, operation-journal, Git-read, and Git-manager boundaries; it must not move SDK/CLI concerns into this plan's workflow code.
