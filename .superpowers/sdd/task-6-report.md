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
