# Task 8 Report: Two-Round Collaboration, Cross-Review, and Lead Integration

## Status

Implementation complete. Task 9 was not started.

## Changes

- Added `CollaborationCoordinator` with:
  - task-scope collaborator authorization;
  - durable idempotent round commands;
  - the initial two-round budget and explicit additional-round support;
  - immutable Lead checkpoint/ref verification;
  - alternate-provider review/parallel roles in a distinct Collaborator worktree;
  - read-only reviewer enforcement;
  - structured immutable diff context;
  - durable `review.started`, `review.completed`, provider, and Collaborator checkpoint events;
  - durable unresolved round-two findings.
- Added `IntegrationService` with:
  - ordered zero/one/multiple checkpoint selection;
  - duplicate, missing, and cross-task rejection;
  - durable idempotent `checkpoint.integrated` and `integration.conflict` events;
  - conflict transition to `Revision`;
  - no direct Git mutation.
- Extended `GitManager`, the sole production Git mutator, with:
  - `verifyCheckpointRef`;
  - `integrateCheckpoint`;
  - `continueIntegration`;
  - repository-lock and operation-journal coverage;
  - create-only ref/OID validation before mutation;
  - clean/no-operation Lead preconditions;
  - ordered cherry-picks with observed HEAD/parent validation;
  - exact bounded porcelain-v2 unmerged files;
  - preserved conflict worktree and `CHERRY_PICK_HEAD`;
  - app identity, disabled hooks, `git add --all`, and `git cherry-pick --continue`;
  - durable same-key replay without repeating Git mutation.
- Extended room-event contracts for structured review and integration results.
- Allowed an explicit round-two agent-review conflict to transition to `Revision`.
- Extended `tests/fixtures/task-engine.ts` with concrete collaboration/integration fixtures, records, checkpoints, request/Git histories, readers, durable receipt helpers, and cleanup.

`src/worker/tasks/task-engine.ts` required no behavioral change: Task 7 already durably records structured collaborator requests and enforces the approved collaborator capability; Task 8 coordination is intentionally isolated in `CollaborationCoordinator`, preserving Task 7 run/cancellation/process-loss behavior.

## TDD RED

Requested command:

```text
pnpm test:integration -- tests/integration/tasks/collaboration-rounds.test.ts tests/integration/git/lead-integration.test.ts
```

Environment result: the Node 20 Corepack wrapper exited 1 before test startup because it attempted an unavailable npm-registry lookup.

Local installed-runner equivalent:

```text
node_modules/.bin/vitest run tests/integration/tasks/collaboration-rounds.test.ts tests/integration/git/lead-integration.test.ts --testTimeout=15000
```

Result: exit 1; 2 failed suites, 0 tests. Both suites failed on the missing `src/worker/tasks/collaboration-coordinator.ts` module, confirming the requested collaboration/integration APIs were absent.

Additional self-review RED:

```text
PATH=/opt/homebrew/bin:/usr/bin:/bin node_modules/.bin/vitest run tests/integration/tasks/collaboration-rounds.test.ts tests/integration/git/lead-integration.test.ts --testTimeout=15000
```

Result: exit 1; 4 failed assertions covering different payloads sharing one in-flight key, missing Collaborator checkpoint event, integrated replay, and conflict replay. Production changes were then made only to satisfy those behaviors.

## GREEN and Regression Verification

Focused GREEN:

```text
PATH=/opt/homebrew/bin:/usr/bin:/bin node_modules/.bin/vitest run tests/integration/tasks/collaboration-rounds.test.ts tests/integration/git/lead-integration.test.ts --testTimeout=15000
```

Result: exit 0; 2 test files passed, 9 tests passed.

Fresh requested integration scope:

```text
PATH=/opt/homebrew/bin:/usr/bin:/bin node_modules/.bin/vitest run tests/integration/tasks/collaboration-rounds.test.ts tests/integration/git/lead-integration.test.ts tests/integration/git/git-manager-checkpoints.test.ts --testTimeout=15000
```

Result: exit 0; 3 test files passed, 18 tests passed.

Unit:

```text
PATH=/opt/homebrew/bin:/usr/bin:/bin node_modules/.bin/vitest run tests/unit
```

Result: exit 0; 30 test files passed, 324 tests passed.

Typecheck:

```text
PATH=/opt/homebrew/bin:/usr/bin:/bin node_modules/.bin/tsc -p tsconfig.node.json --noEmit
PATH=/opt/homebrew/bin:/usr/bin:/bin node_modules/.bin/tsc -p tsconfig.renderer.json --noEmit
```

Result: both exited 0 with no diagnostics.

Changed-file lint and whitespace:

```text
PATH=/opt/homebrew/bin:/usr/bin:/bin node_modules/.bin/eslint src/shared/contracts/domain.ts src/worker/git/git-manager.ts src/worker/git/integration-service.ts src/worker/tasks/collaboration-coordinator.ts src/worker/tasks/task-state-machine.ts tests/fixtures/task-engine.ts tests/integration/tasks/collaboration-rounds.test.ts tests/integration/git/lead-integration.test.ts --max-warnings=0
git diff --check
```

Result: both exited 0 with no diagnostics.

## Self-Review

- Confirmed no Claude/Codex SDK, CLI, authentication, or network dependency was introduced.
- Confirmed Providers receive only a request/capability object and never receive GitManager, a shell, the database, or another worktree.
- Confirmed reviewer readable/writable authority excludes the Lead live directory.
- Confirmed all production `cherry-pick`, `add`, and continuation mutations occur only inside GitManager.
- Confirmed no conflict path invokes abort, reset, checkout, worktree deletion, or cleanup.
- Confirmed every selected immutable ref is checked under the repository lock before mutation and caller order is preserved.
- Confirmed transitions/events are durable before optional publication.
- Confirmed same-key replay does not repeat Provider/Git mutation or duplicate transition/events.
- Confirmed Task 7 unit coverage remains green.

## Concerns

- The exact `pnpm` wrapper could not start in this sandbox because its old Corepack installation attempted an offline registry lookup and then used Node 20, which lacks `node:sqlite`. Verification used the already-installed project binaries with Homebrew Node 25; all requested test scopes and typechecks passed.

## Fix round 1

### Status

All six Important review findings were addressed. The Task 8 implementation remains
scoped to collaboration, Lead integration, and production composition; Task 9 was not
started.

### TDD RED evidence

Tests were added before the production fixes and run with Node 24 and serialized real-Git
execution.

```text
/Users/jason8607/.nvm/versions/node/v24.18.0/bin/node \
  node_modules/vitest/vitest.mjs run \
  tests/integration/tasks/collaboration-rounds.test.ts \
  --no-file-parallelism --maxWorkers=1 --testTimeout=180000 \
  -t "uses TaskEngine cancellation|enforces the approved maxRunMs|uses durable round context|atomically commits the review|durably completes round two once"
```

Observed failures included:

- TaskEngine cancellation reached `Cancelled`, but the reviewer Provider remained alive
  and the round promise did not settle.
- reviewer `maxRunMs` had no deadline enforcement.
- a completed round-two review accepted and persisted a conflicting completion under a
  different idempotency key.
- the oldest-500 event lookup could not find a recent review context.
- a rejected `review.completed` event left the Task in `Revision`, proving the Task
  transition and event were not atomic.

```text
/Users/jason8607/.nvm/versions/node/v24.18.0/bin/node \
  node_modules/vitest/vitest.mjs run \
  tests/integration/git/lead-integration.test.ts \
  --no-file-parallelism --maxWorkers=1 --testTimeout=180000 \
  -t "rejects an invalid task phase|durably reserves the task version|replays integration from its durable|atomically finalizes a conflict|re-observes the canonical"
```

Observed failures included:

- a `Cancelled` task still cherry-picked a checkpoint.
- a task transition succeeded while an integration mutation was reserved.
- replay depended on an event-page scan.
- a rejected `integration.conflict` event left the Task in `Revision`.
- `continueIntegration` accepted a re-observed Git common-directory mismatch and ran the
  continuation.

The production-composition test initially failed because
`task-execution-services.ts` did not exist. The fail-closed Provider assertion then
failed because `unavailable-provider.ts` did not exist.

### GREEN implementation

- Moved collaborator/reviewer Provider execution into `TaskEngine` so Lead and
  collaboration runs share the same pending/active maps, run lifecycle, cancellation
  path, Provider event handling, and approved deadline.
- Added a task-side-effect guard. Cancellation captures the active/pending handle in the
  same guarded state transition, so no Provider write or Collaborator checkpoint can
  begin after cancellation becomes durable.
- Added durable `collaboration_rounds` and `task_service_commands` storage through
  migration 3.
- Made review start atomic across command reservation, task transition, round context,
  and `review.started`.
- Made review completion atomic across the optional revision transition,
  `review.completed`, the one-time round completion marker, and service-command result.
  Same-payload replay is idempotent across keys; conflicting round completion is rejected.
- Reserved an allowed `Review1`/`Review2` task version before checkpoint integration.
  Normal task transitions are rejected while that mutation is pending.
- Made integration result/event/conflict-transition finalization one SQLite transaction.
  A crash after Git mutation leaves an explicit pending command that requires
  reconciliation instead of replaying Git.
- Removed both bounded room-event scans as idempotency or review-context sources.
- Re-observed and compared the Lead worktree's canonical Git common directory before
  locking and continuing a cherry-pick, including comparison with a prior journal record.
- Replaced the vacuous Provider Git assertion with actual Git runner argv-order
  assertions and verified the Collaborator checkpoint's real first parent equals its
  recorded worktree base OID.
- Added the production `createTaskExecutionServices` seam and wired it in worker runtime.
  Normal runtime uses `UnavailableProvider`; it does not construct `MockProvider` and
  rejects execution as `PROVIDER_UNAVAILABLE`.
- Preserved the unchanged `GitCommandRunner` contract: `/usr/bin/git`, argv-only
  `execFile`, `shell: false`, controlled environment, app-local identity, and disabled
  hooks.

### Regression found and corrected

The first full cancellation regression found that awaiting the new side-effect guard
could let a pending Lead run move between maps before cancellation captured its handle,
skipping a queued workspace write. Lifecycle instrumentation showed the run was pending
before cancel and absent from both maps afterward. Cancellation now captures the
active/pending handle atomically with its guarded transition. The focused regression and
the full cancellation suite then passed.

### Verification

```text
Task 8 + checkpoint + production composition:
4 files passed; 29 tests passed

TaskEngine cancellation/run + production composition:
3 files passed; 31 tests passed

Storage/event/runtime:
4 files passed; 37 tests passed

Unit:
30 files passed; 324 tests passed

Node typecheck:
tsc -p tsconfig.node.json --noEmit — exit 0

Renderer typecheck:
tsc -p tsconfig.renderer.json --noEmit — exit 0

Changed-file ESLint:
16 files, --max-warnings=0 — exit 0

git diff --check — exit 0
```

All real-Git suites used:

```text
--no-file-parallelism --maxWorkers=1 --testTimeout=180000
```

### Self-review

- Confirmed the runtime has one SQLite owner, one GitManager, and one shared TaskEngine
  supervisor for Provider lifecycle work.
- Confirmed no real Claude/Codex SDK, CLI, auth, shell callback, or executable Provider
  was added.
- Confirmed Provider capabilities still contain only the scoped filesystem/context
  contract and no Git runner or GitManager.
- Confirmed an invalid/terminal task cannot reach a Git mutation and a reserved
  integration cannot be invalidated by a concurrent task transition.
- Confirmed event-trigger failures roll back the associated task transition and durable
  completion marker.
- Confirmed same-key and cross-key replay no longer depends on room event pagination.
- Confirmed Git conflict state remains visible and no abort/reset/checkout/cleanup path
  was introduced.
- Confirmed no unrelated Task 9 behavior or Task 13 IPC/UI command was implemented.

### Concerns

None.
