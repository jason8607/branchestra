# Task 6 Implementation Report

Status: DONE_WITH_CONCERNS

## Outcome

Implemented `GitArtifactRepository` and the sole `GitManager` mutation boundary for
isolated Agent worktrees and immutable checkpoints. Every production Git invocation still
uses the existing hardened `GitCommandRunner`; every mutation is serialized by canonical
common-dir identity and recorded as durable intent/observation. No Provider SDK, CLI,
authentication, storage access, child-process access, force/reset/clean/stash/remove
fallback, or cleanup-on-failure path was added.

## TDD Evidence

Initial RED command:

```text
/Users/jason8607/.nvm/versions/node/v24.18.0/bin/node \
  node_modules/vitest/vitest.mjs run \
  tests/unit/git/provider-git-boundary.test.ts \
  tests/integration/git/git-manager-worktrees.test.ts \
  tests/integration/git/git-manager-checkpoints.test.ts \
  --testTimeout=15000
```

Initial RED result: 2 integration tests failed exactly because
`createGitManagerFixture` and `createPreparedLeadFixture` did not exist; the source-boundary
test passed. This was the expected missing-public-boundary failure before production edits.

First GREEN result: 3 files, 3 tests passed after the minimum repository, manager, and
fixture slice.

Final focused command:

```text
/Users/jason8607/.nvm/versions/node/v24.18.0/bin/node \
  node_modules/vitest/vitest.mjs run \
  tests/unit/git/git-artifact-repository.test.ts \
  tests/unit/git/provider-git-boundary.test.ts \
  tests/integration/git/repository-inspector.test.ts \
  tests/integration/git/git-manager-worktrees.test.ts \
  tests/integration/git/git-manager-checkpoints.test.ts \
  --testTimeout=15000
```

Final focused result: 5 files, 53 tests passed.

## Implemented Behavior

- Explicit worktree, checkpoint, candidate, selected-checkpoint, and test-result column
  mapping, with worktree/task ownership checks and declared candidate ordinal preservation.
- Task 2 immutable checkpoint trigger retained and exercised.
- Deterministic worktree paths and branch refs from validated engine IDs only.
- Exact absent/present worktree observation table, including partial branch recovery,
  no-op replay, wrong-OID/path/ref conflict, and pre-existing-directory rejection.
- Canonical managed-root, repository-root, linked-worktree realpath, and Git common-dir
  re-observation immediately after worktree creation.
- Repository-scoped locking for worktree/branch/commit/ref mutation, with distinct
  repositories remaining parallel.
- Durable `worktree.ensure`, `checkpoint.commit`, and `checkpoint.ref.create`
  intents/observations with idempotent completed-result replay.
- Checkpoint HEAD/branch preconditions; `git add --all`; allow-empty, no-GPG commit with
  fixed Branchestra identity and reserved immutable checkpoint trailer.
- Commit observation of full HEAD, single parent, trailer, index tree, commit tree, author
  name/email, and branch before persistence.
- Create-only immutable refs using an object-format-length zero OID and direct full-OID
  observation; existing refs are accepted only at the identical direct OID.
- Persistence occurs only after Git observation; checkpoint rows are linked to the same-task
  worktree and the worktree's current checkpoint is updated.
- Fixture support for real manager/database/repositories/journal/lock, argv history,
  deterministic hooks, canonical worktree readers/writers, concurrency gates, and optional
  SHA-256 repositories.
- Recursive Provider source-boundary test forbidding GitManager, GitCommandRunner,
  operation mutation boundaries, child processes, storage, and exported mutating Git
  commands.

## Preservation and Race Coverage

- Branch-created/worktree-missing recovery in the same live request.
- External wrong-OID branches remain unchanged and journal `needs_attention`.
- Pre-existing target directories and contents remain untouched.
- Cancellation injected immediately after successful `worktree add` retains the branch and
  worktree; re-observation safely completes the journal.
- Cancellation injected after `git add --all` retains staged and unstaged content and marks
  the commit operation `needs_attention`.
- A ref created externally between commit and create-only update remains unchanged; the new
  checkpoint commit and worktree contents remain visible while the ref journal records
  `needs_attention`.
- Same-repository tasks serialize; distinct-repository tasks enter mutation concurrently.
- Empty commits, repeated idempotency, changed-intent reuse rejection, hook suppression,
  author/trailer/index/parent observation, and conditional SHA-256 64-character OIDs are
  covered.
- Tests assert no reset, clean, stash, worktree removal, force, or artifact deletion path.

## Verification

- Full unit: 29 files, 312 tests passed.
- Final focused Git/storage boundary: 5 files, 53 tests passed.
- Full integration attempt: 10 files and 105 tests passed; one build-wrapper test failed.
- Node typecheck: passed.
- Renderer typecheck: passed.
- ESLint with zero warnings: passed.
- Direct Node 24 `electron-vite build`: passed.
- `git diff --check`: passed.

The only full-integration failure was
`tests/integration/electron-vite-config.test.ts`. Its internal `pnpm build` launched
Corepack under Node 20 and attempted to resolve `https://registry.npmjs.org/pnpm/latest`;
restricted network access produced `ENOTFOUND`. This is the environment limitation called
out in the task brief. No network access was requested or used. The equivalent direct
Node 24 build passed; controller verification can run the complete suite with its fixed
Node 24 wrapper.

## Self-Review

Confirmed that `GitManager` is the only new production Git mutation boundary, all Git
commands remain argv-only through the fixed runner, lock keys are canonical common dirs,
refs are observed as direct full OIDs, journaled replay never retries an incomplete
sensitive operation, and every conflict/cancellation test retains visible artifacts.
Checked the final source for forbidden destructive Git commands and Provider imports.
The sole concern is the environment-dependent Corepack full-integration wrapper failure
described above.

## Controller Verification

After commit `a103583`, the controller supplied a temporary fixed-Node-24 wrapper only for
the integration test's internal `pnpm build` subprocess and reran the complete integration
directory without exclusions. Result: 11 files, 106 tests passed. The wrapper lived outside
the repository and did not modify production or test code; the Corepack concern is resolved
for the reviewed source state.

## Review Fix Round

Status: DONE_WITH_CONCERNS

All six Important findings in `task-6-review.md` were addressed test-first. Production
behavior was not changed until all six focused regressions had produced the expected RED.

### RED/GREEN Evidence

1. Intermediate symlink authorization:

   ```text
   /Users/jason8607/.nvm/versions/node/v24.18.0/bin/node \
     node_modules/vitest/vitest.mjs run \
     tests/integration/git/git-manager-worktrees.test.ts \
     -t "rejects an intermediate symlink escape" --testTimeout=15000
   ```

   RED: 1 failed because `<outside>/task-1` was created before rejection.
   GREEN: 1 passed; no outside directory and no `git worktree add` launch.

2. Completed same-key worktree replay:

   ```text
   /Users/jason8607/.nvm/versions/node/v24.18.0/bin/node \
     node_modules/vitest/vitest.mjs run \
     tests/integration/git/git-manager-worktrees.test.ts \
     -t "completed same-key replay" --testTimeout=15000
   ```

   RED: 2 failed because removed-worktree and wrong-OID replays both returned stale success.
   GREEN: 2 passed; both now require reconciliation without Git mutation.

3. HEAD/metadata binding:

   ```text
   /Users/jason8607/.nvm/versions/node/v24.18.0/bin/node \
     node_modules/vitest/vitest.mjs run \
     tests/integration/git/git-manager-checkpoints.test.ts \
     -t "different HEAD" --testTimeout=15000
   ```

   RED: 1 failed because a real external branch race resolved and persisted the first,
   unvalidated HEAD OID. GREEN: 1 passed; metadata is read by exact OID and both initial and
   final HEAD must match that OID.

4. Atomic checkpoint/pointer persistence:

   ```text
   /Users/jason8607/.nvm/versions/node/v24.18.0/bin/node \
     node_modules/vitest/vitest.mjs run \
     tests/unit/git/git-artifact-repository.test.ts \
     tests/integration/git/git-manager-checkpoints.test.ts \
     -t "rolls back checkpoint insertion|atomically persists" --testTimeout=15000
   ```

   RED: 2 failed; the repository had no atomic API and an injected pointer failure left the
   checkpoint row committed. GREEN: 2 passed; the transaction rolls back both rows and a
   fresh manager retries the completed Git observations and persists both rows together.

5. Observer-exception durability:

   ```text
   /Users/jason8607/.nvm/versions/node/v24.18.0/bin/node \
     node_modules/vitest/vitest.mjs run \
     tests/unit/operations/journaled-operation-runner.test.ts \
     tests/integration/git/git-manager-checkpoints.test.ts \
     -t "observation exception|post-update-ref observation" --testTimeout=15000
   ```

   RED: 2 failed because generic and post-`update-ref` observer exceptions both left the
   journal `executing`. GREEN: 2 passed; both durably record `uncertain`/`needs_attention`,
   retain the ref, and preserve the original thrown error.

6. Transitive Provider source boundary:

   ```text
   /Users/jason8607/.nvm/versions/node/v24.18.0/bin/node \
     node_modules/vitest/vitest.mjs run tests/unit/git/provider-git-boundary.test.ts
   ```

   RED: 1 failed with `ENTRY_OR_IMPORT_MISSING`, `PROVIDER_ENTRY_REQUIRED`, and
   `PROVIDER_GIT_READ_PORT_REQUIRED`; the malicious intermediary regression already passed.
   GREEN: 2 passed; the actual entry/read-port graph is non-vacuous and a resolved
   transitive storage import is rejected.

### Fixes

- Canonicalize and inspect every existing managed-path component before recursive `mkdir`;
  symlink and non-directory components fail before any write or child launch.
- Re-observe completed worktree operations under the repository lock and accept the
  completed result only for an exact expected no-op; all other live states require
  reconciliation and never execute mutation.
- Observe checkpoint metadata by the captured full OID, record the metadata OID, and require
  captured HEAD, metadata OID, and final HEAD to be identical.
- Add `GitArtifactRepository.persistCheckpoint()` to insert the checkpoint and advance the
  same worktree pointer in one SQLite transaction.
- Make `JournaledOperationRunner` durably record observer exceptions as uncertain
  `needs_attention` while rethrowing the original exception; execute exceptions retain their
  prior behavior.
- Add actual `provider-entry.ts` and a dedicated type-only `provider-git-read-port.ts`.
  The boundary test traverses resolved local imports/re-exports transitively, treats the
  approved type-only read-service edge as terminal, rejects missing entries, and proves a
  malicious intermediary cannot hide storage authority.

### Changed Files

- `.superpowers/sdd/task-6-report.md`
- `src/worker/git/git-manager.ts`
- `src/worker/git/git-artifact-repository.ts`
- `src/worker/operations/journaled-operation-runner.ts`
- `src/worker/providers/provider-entry.ts`
- `src/worker/providers/provider-git-read-port.ts`
- `tests/fixtures/git-repository.ts`
- `tests/integration/git/git-manager-worktrees.test.ts`
- `tests/integration/git/git-manager-checkpoints.test.ts`
- `tests/unit/git/git-artifact-repository.test.ts`
- `tests/unit/git/provider-git-boundary.test.ts`
- `tests/unit/operations/journaled-operation-runner.test.ts`

### Fix-Round Verification

- Named unit/artifact/provider/journal suites: 3 files, 19 tests passed.
- Named Git integration suites: 3 files, 56 tests passed.
- Full unit: 29 files, 314 tests passed.
- Full integration attempt: 10 files and 111 tests passed; one build-wrapper test failed.
- Node and Renderer typechecks: passed.
- ESLint with zero warnings: passed.
- Direct Node 24 `electron-vite build`: passed.
- `git diff --check`: passed.

The only full-integration failure remains the environment-owned
`tests/integration/electron-vite-config.test.ts` subprocess. Its internal `pnpm build`
launched Node 20 Corepack, attempted `https://registry.npmjs.org/pnpm/latest`, and failed
with `ENOTFOUND`. No network access was requested. The direct Node 24 build passed; the
controller can run the full integration directory with its fixed Node 24 wrapper.
