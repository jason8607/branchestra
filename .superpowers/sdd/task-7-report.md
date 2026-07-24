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

## Controller Verification

After commit `6a2df01`, the controller used the temporary fixed-Node-24 wrapper only for the
integration test's internal build subprocess and ran the full integration directory without
exclusions: 13 files, 137 tests passed. The wrapper remained outside the repository.

## Review Fix Round

Status: DONE

Both Important lifecycle findings in `task-7-review.md` were fixed test-first.

### RED Evidence

MockProvider consumer-close/resource command:

```text
/Users/jason8607/.nvm/versions/node/v24.18.0/bin/node \
  node_modules/vitest/vitest.mjs run tests/unit/providers/mock-provider.test.ts
```

RED: 3 failed and 5 passed. Both early consumer-close cases rejected with
`MOCK_COMPLETION_DID_NOT_SETTLE`, and the oldest of 80 completed run IDs was still retained.

TaskEngine cancellation-timeout command:

```text
/Users/jason8607/.nvm/versions/node/v24.18.0/bin/node \
  node_modules/vitest/vitest.mjs run \
  tests/integration/tasks/task-engine-cancellation.test.ts \
  -t "retires timed-out handles" --testTimeout=5000
```

RED: 1 failed because the durable task/run were Failed but the engine still retained one
active handle. The original implementation also allowed its late completion continuation
to reach the closed fixture database.

### Fixes

- `AsyncIterator.return()` now settles the MockProvider run exactly once as cancelled,
  aborts blocked producers, detaches the queue callback, closes waiters, and removes the
  active run entry.
- Completed/cancelled/failed mock runs retain only a bounded 64-entry terminal tombstone map.
  Recent repeated cancel remains idempotent; evicted IDs can be safely reused without
  retaining controllers, queues, or deferred completions.
- TaskEngine starts the cancellation grace deadline before pending-handle adoption and
  retires active and pending registrations in a `finally` path for success, timeout, or
  Provider error.
- Provider errors remain unwrapped. Cancellation timeout durably marks the run/task Failed,
  and late Provider start/event/completion continuations return the existing durable result
  without changing run state, creating a checkpoint, or re-registering a stale handle.
- An engine-owned cancellation-settlement promise keeps the concurrent start call aligned
  with the final Cancelled/Failed record while still consuming events buffered before a
  successful cancellation.

### GREEN and Verification Evidence

- Focused Provider/engine boundary: 4 files, 38 tests passed.
- Full unit: 30 files, 324 tests passed.
- Relevant TaskEngine integration: 2 files, 26 tests passed.
- Node and Renderer typechecks: passed.
- ESLint with zero warnings: passed.
- `git diff --check`: passed.

## Review Fix Handoff Verification

Revalidated the inherited dirty lifecycle fixes without discarding or reverting them.
The default `pnpm` entry point selected Node 20 Corepack and failed before running tests
because it attempted to resolve `https://registry.npmjs.org/pnpm/latest` in the
network-restricted environment. No dependency download or network escalation was used.

Equivalent commands were run directly with the repository's installed dependencies and
required Node 24.18.0:

```text
/Users/jason8607/.nvm/versions/node/v24.18.0/bin/node \
  node_modules/vitest/vitest.mjs run tests/unit/providers/mock-provider.test.ts
```

Result: 1 file, 8 tests passed.

```text
/Users/jason8607/.nvm/versions/node/v24.18.0/bin/node \
  node_modules/vitest/vitest.mjs run \
  tests/integration/tasks/task-engine-run.test.ts \
  tests/integration/tasks/task-engine-cancellation.test.ts \
  --testTimeout=15000
```

Result: 2 files, 26 tests passed. An initial direct invocation without the package
script's `--testTimeout=15000` reproduced seven 5-second fixture timeouts and no assertion
failure; the command above matches `test:integration` configuration.

```text
git diff --check
/Users/jason8607/.nvm/versions/node/v24.18.0/bin/node \
  node_modules/vitest/vitest.mjs run tests/unit
/Users/jason8607/.nvm/versions/node/v24.18.0/bin/node \
  node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit
/Users/jason8607/.nvm/versions/node/v24.18.0/bin/node \
  node_modules/typescript/bin/tsc -p tsconfig.renderer.json --noEmit
/Users/jason8607/.nvm/versions/node/v24.18.0/bin/node \
  node_modules/eslint/bin/eslint.js . --max-warnings=0
```

Results: diff check passed; 30 unit files and 324 tests passed; both typechecks passed;
ESLint passed with zero warnings.

### Handoff Self-Review

- Mock terminal settlement is single-shot, removes the live run before resolving
  completion, aborts blocked producers, closes queue readers/capacity waiters, and retains
  at most 64 terminal IDs for recent idempotent cancellation.
- Consumer `return()` detaches its callback before settling, so the settlement-triggered
  queue close cannot recurse.
- Cancellation starts one bounded deadline before adopting a pending handle and removes
  active and pending registrations in `finally` on success, timeout, or Provider error.
- After timeout, durable Failed task/run state gates late start, event, and completion
  continuations before event persistence or checkpoint creation.
- The diff remains limited to Task 7 lifecycle implementation, its fixture/tests, and this
  report. No Task 8, SDK/CLI adapter, Git cleanup, or process-management behavior was added.

Concern: only the environment's default Node 20 Corepack launcher is unusable offline;
direct Node 24 verification is green.

## Cancellation Terminal Re-review Fix

Status: DONE

Implemented all three Important re-review findings test-first.

### RED Evidence

Terminal MockProvider identity:

```text
/Users/jason8607/.nvm/versions/node/v24.18.0/bin/node \
  node_modules/vitest/vitest.mjs run tests/unit/providers/mock-provider.test.ts
```

RED: 1 failed and 7 passed. Cancelling the oldest of 80 completed runs rejected with
`MOCK_RUN_NOT_FOUND:run-0`, proving terminal identity was incorrectly evicted.

Pending-start and rejected-cancel paths:

```text
/Users/jason8607/.nvm/versions/node/v24.18.0/bin/node \
  node_modules/vitest/vitest.mjs run \
  tests/integration/tasks/task-engine-cancellation.test.ts \
  -t "cancels a pending start immediately|persists terminal failure when Provider cancellation rejects" \
  --testTimeout=5000
```

RED: both selected tests failed. The rejection escaped as
`CANCEL_REJECTED: adapter unavailable`; the first pending test run also exposed a test-only
teardown wait, which was corrected without changing production code. The precise pending
RED was then rerun alone and failed with `PENDING_CANCEL_NOT_DISPATCHED`.

### Fixes

- Pending cancellation now dispatches `provider.cancelRun` immediately with the durable
  run ID before awaiting `startRun`. Cancellation acknowledgement, late handle acquisition,
  and completion all share the original single grace deadline.
- A handle that arrives after the timeout observes durable Failed state and has its event
  iterator closed through `return()` without reading an event, registering as active,
  persisting an agent event, or creating a checkpoint.
- A synchronous throw or rejected `cancelRun` now marks the durable run Failed, transitions
  the task to Failed with the Provider's structured code/message, completes the engine
  command for idempotent replay, and clears active/pending supervision maps in `finally`.
- MockProvider now retains every terminal run ID for its lifetime while deleting the live
  `MockRun`. Repeated cancellation of any known run remains idempotent, unknown IDs still
  reject, and terminal IDs cannot be reused.

### GREEN and Regression Evidence

Focused GREEN commands:

```text
/Users/jason8607/.nvm/versions/node/v24.18.0/bin/node \
  node_modules/vitest/vitest.mjs run tests/unit/providers/mock-provider.test.ts

/Users/jason8607/.nvm/versions/node/v24.18.0/bin/node \
  node_modules/vitest/vitest.mjs run \
  tests/integration/tasks/task-engine-cancellation.test.ts \
  -t "cancels a pending start immediately|persists terminal failure when Provider cancellation rejects" \
  --testTimeout=5000
```

Results: MockProvider 8/8 passed; new cancellation cases 2/2 passed.

Required regression command:

```text
/Users/jason8607/.nvm/versions/node/v24.18.0/bin/node \
  node_modules/vitest/vitest.mjs run \
  tests/unit/providers/mock-provider.test.ts \
  tests/integration/tasks/task-engine-run.test.ts \
  tests/integration/tasks/task-engine-cancellation.test.ts \
  --testTimeout=15000
```

Result: 3 files, 36 tests passed.

Static verification:

```text
git diff --check
/Users/jason8607/.nvm/versions/node/v24.18.0/bin/node \
  node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit
/Users/jason8607/.nvm/versions/node/v24.18.0/bin/node \
  node_modules/typescript/bin/tsc -p tsconfig.renderer.json --noEmit
/Users/jason8607/.nvm/versions/node/v24.18.0/bin/node \
  node_modules/eslint/bin/eslint.js . --max-warnings=0
```

Results: diff check, both typechecks, and ESLint with zero warnings all passed.

### Self-Review

- `cancelRun` is invoked synchronously after the grace timer starts and before any pending
  handle await; no second timeout window is introduced.
- Timeout and Provider rejection both persist run state before task state and complete the
  durable engine command before returning.
- Every cancellation outcome clears active and pending maps in `finally`; late pending
  handles are closed at the durable-state gate and cannot enter event processing.
- Terminal MockProvider entries contain only string IDs. Controllers, queues, deferred
  completions, and buffered events remain reachable only from the returned handle, not the
  Provider's live-run registry.
- Changes remain within Task 7 Provider/task lifecycle implementation, tests, and report.
  No Task 8 behavior was introduced.

Concerns: none.
