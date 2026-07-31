# Task 5 Implementation Report

Status: DONE_WITH_CONCERNS

## Outcome

Implemented mention-driven task creation and durable capability receipts on the existing
worker command path and canonical SQLite/EventStore wiring. No provider SDK, CLI,
authentication, second SQLite connection, second EventStore, or second command router was
added.

## TDD Evidence

Initial RED command:

```text
/Users/jason8607/.nvm/versions/node/v24.18.0/bin/node node_modules/vitest/vitest.mjs run \
  tests/unit/tasks/mention-parser.test.ts \
  tests/unit/approvals/approval-service.test.ts \
  tests/unit/approvals/approved-workspace.test.ts \
  tests/integration/tasks/task-approval.test.ts
```

Initial RED result: 4 failed suites, each failing at import because
`mention-parser`, `approval-service`, `canonical-json`, `approved-workspace`, and the
task-engine fixture did not exist. This was the expected missing-behavior failure.

Further focused RED/GREEN slices:

- Protocol/router RED: 4 failures for missing message scope fields, worker task commands,
  task response data, and handler registration; GREEN: 21/21.
- Renderer gateway RED: 2 failures for unsupported `task.approveScope` and
  `task.grantAdditionalRound`; GREEN: 33/33.
- Git read error mapping RED: `GitReadError` mapped to `INTERNAL`; GREEN after stable
  `GIT_INVALID` mapping.
- Final focused behavior gate: 8 files, 83 tests passed.

## Implemented Behavior

- Deterministic `@Claude`/`@Codex` parsing with inline-code and email false-positive
  rejection, case folding, and stable de-duplication.
- Read-only Git identity/status inspection before task mutation, immutable `headRef` and
  `headOid` capture, dirty-main warning, and in-transaction Room/Project revalidation.
- One atomic transaction for the task, pending request, `task.created`,
  `approval.requested`, and durable `:task`, `:approval-request`, and `:timeline`
  idempotency records.
- Ambiguous-lead rejection and explicit-lead validation.
- Canonical JSON/hash implementation with sorted object keys, preserved array order,
  and rejection of non-finite numbers, functions, symbols, bigint, and cycles.
- Scope approval/rejection with hash and generation checks, immutable receipt insertion,
  task state transition, trusted events, and duplicate replay without duplicate events.
- Additional-round grants only through a new approved, generation-bound receipt.
- Task-scope receipts survive worker restarts; sensitive receipts do not.
- Worktree write capability with journaled intent/observation, exact path/content hash,
  immediate path re-resolution, and final-file `O_NOFOLLOW`.
- Existing renderer gateway, worker request schema, typed handler registry, worker router,
  and runtime wiring extended without a parallel path.
- Shared `createApprovedTaskFixture(options?)` with real Git, canonical repositories/events,
  captureGitState, deterministic injection seams, and cleanup.

## Verification

- Unit: 27 files, 309 tests passed.
- Integration excluding the known build-wrapper test: 8 files, 91 tests passed.
- Node typecheck: passed.
- Renderer typecheck: passed.
- ESLint (`--max-warnings=0`): passed.
- Direct `electron-vite build` under fixed Node 24: passed.
- `git diff --check`: passed.

Full integration was attempted. Its only failure was
`tests/integration/electron-vite-config.test.ts`, whose internal `pnpm build` launched
Corepack under Node 20 and attempted `https://registry.npmjs.org/pnpm/latest`; restricted
network access produced `ENOTFOUND`. The other 8 integration files passed in that run
(92 tests passed, 1 build-wrapper test failed). No network access was requested or used.

Controller verification after commit used a temporary fixed-Node-24 `pnpm build` wrapper
for that infrastructure-only subprocess and ran the complete integration directory without
exclusions: 9 files, 93 tests passed. The wrapper was outside the repository and did not
modify production or test code.

## Self-Review

Confirmed canonical repository/EventStore use, one transaction for creation and decisions,
stable replay, no pre-approval Git mutation, no production generic filesystem/process/Git
escape, restart receipt rules, capability hash validation, and both parent/leaf symlink-swap
failure tests. The remaining concern is limited to the environment-dependent Corepack
wrapper described above; the equivalent direct build passes.
