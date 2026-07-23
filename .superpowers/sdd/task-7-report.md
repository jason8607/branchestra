# Task 7 Implementation Report

Status: DONE_WITH_CONCERNS

## Outcome

Implemented the SDK-independent Provider execution port, deterministic bounded in-process
MockProvider, and durable TaskEngine orchestration for approved Lead runs, cancellation,
failure, checkpointing, and process loss. Provider code receives no database, Git manager,
process launcher, SDK, CLI, authentication, or writable filesystem authority.

## TDD Evidence

The first Provider/mock RED command was:

```text
/Users/jason8607/.nvm/versions/node/v24.18.0/bin/node \
  node_modules/vitest/vitest.mjs run tests/unit/providers/mock-provider.test.ts
```

It failed as expected with one failed suite and zero collected tests because
`mock-provider` did not exist. The first Provider/mock GREEN ran the mock contract and
existing recursive Provider source boundary: 2 files, 8 tests passed.

The first TaskEngine happy-path RED failed 1/1 because `createTaskEngineFixture` did not
exist. After the minimum real SQLite/EventStore/GitManager/ApprovedWorkspace slice, it
passed 1/1 with a real isolated worktree, durable Provider events, approved write, immutable
checkpoint, and event-before-publish proof.

The denial/cancellation/process-loss RED ran 24 tests: 20 failed and 4 passed. Failures were
the expected missing fixture helpers, duplicate replay, placeholder cancellation/loss
methods, and one active-cancellation timeout. The timeout exposed a real pending-start race:
the mock could reach `waitForCancel` before the engine's awaited `startRun` continuation
registered the active handle. An engine-owned pending-run registration fixed the race.

Additional focused RED/GREEN cycles covered:

- A different start key after Checkpoint initially returned a new Failed state; it now
  rejects without mutating the checkpointed task.
- Process loss initially re-observed but did not persist Git status; it now records a
  completed `process_loss.git_status` operation-journal observation, or an uncertain
  durable observation when reading fails.

Final focused result: 4 files, 34 tests passed, covering MockProvider, the recursive Provider
boundary, TaskEngine run/denial/failure/idempotency, cancellation, and process loss.

## Implemented Behavior

- A narrow structural Provider port containing only task/run identifiers, approved
  capabilities, normalized events, session IDs, completion, resume, and cancellation.
  Its provider-facing primitive aliases are intentionally self-contained so the Provider
  graph cannot transitively import the shared workflow/Git domain module.
- Deterministic MockProvider scripts with a 16-item bounded async queue, one AbortController
  per run, blocking cancellation steps, structured script failures, persisted-session
  resume behavior, idempotent repeated cancellation, and unknown-run rejection.
- Durable async engine-command records using the canonical idempotency table. Completed
  start/cancel/loss commands replay their TaskRecord; pending commands require
  reconciliation and changed-intent key reuse fails closed.
- Scope-receipt hash/decision/task/restart-survival revalidation and exact canonical
  repository/common-dir/worktree authorization before Provider dispatch.
- Preparing and Working transitions, durable `agent_runs` session/state records, normalized
  `agent.run` persistence before publish, and contents represented by hashes in events.
- All writes routed through ApprovedWorkspace. Parent traversal and post-approval symlink
  escapes fail before filesystem mutation. Unapproved tests and collaborator requests fail
  before process/collaborator dispatch.
- Provider completion finalizes the run before GitManager checkpoint creation, persists
  `checkpoint.created`, then transitions to Checkpoint. Provider/event failures transition
  to Failed and never clean up Git artifacts.
- Cancellation first records the pure cancel transition, stops dispatch, adopts a
  concurrently pending Provider handle when necessary, bounds `cancelRun` plus completion
  by the approved deadline, persists final run state, and settles Cancelled. Timeout records
  structured `CANCEL_GRACE_TIMEOUT`.
- Direct cancellation in Preparing and post-checkpoint cancellation preserve all artifacts.
  Repeated same-intent keys replay without another Provider call.
- Process loss invokes no Provider method. It durably records read-only Git status, marks
  every starting/running run interrupted, applies the pure process-loss transition with the
  exact prior phase and unchanged collaboration count, and retains branch, worktree,
  checkpoint, ref, index, and uncommitted files.
- Fixture support returns typed engine/mock/repositories/events/artifacts/manager/generation,
  Provider and Git call observations, Lead file/ref/path helpers, process-loss journal
  access, and idempotent cleanup.

## Coverage

- Happy approved write/checkpoint and event-before-publish ordering.
- Parent traversal and post-approval symlink escape denial.
- Unapproved test/collaborator requests and Provider failure.
- Duplicate start and cancel keys; invalid new start after Checkpoint.
- Active cancellation, cancellation in Preparing, and cancellation after Checkpoint.
- Every non-terminal state moving to Interrupted with exact prior state and preserved
  collaboration count.
- Active-run interruption, durable Git status, dirty-file/worktree/ref preservation, and
  zero start/resume/cancel Provider calls during loss handling.
- Mock completed, cancelled, unknown-run, resume, and scripted-throw behavior.

## Verification

- Focused final: 4 files, 34 tests passed.
- Full unit: 30 files, 321 tests passed.
- Full integration attempt: 12 files and 136 tests passed; one known build-wrapper test
  failed before executing its assertion.
- Node typecheck: passed.
- Renderer typecheck: passed.
- ESLint with zero warnings: passed.
- Direct Node 24 Electron/Vite build: passed.
- `git diff --check`: passed.

The sole concern is the existing environment-dependent
`tests/integration/electron-vite-config.test.ts` wrapper. Its internal `pnpm build` selected
Node 20 Corepack and attempted to resolve `https://registry.npmjs.org/pnpm/latest`; restricted
network access returned `ENOTFOUND`. As required, no network escalation or alternate package
installation was attempted. The equivalent direct Node 24 build passed.

## Self-Review

Confirmed that Provider imports remain clean under the recursive boundary scanner; TaskEngine
alone owns orchestration, repositories, ApprovedWorkspace, and GitManager; every normalized
Provider event is durable before publish; cancellation and failures never remove or rewrite
Git artifacts; process loss performs no Provider restart/resume/cancel; sensitive incomplete
operations never auto-replay; and no Milestone 3 SDK/CLI/executable enforcement was added.
