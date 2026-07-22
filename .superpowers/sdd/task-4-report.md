# Task 4 Report: Safe Git Read Boundary and Workspace Paths

## Status

GREEN. The fixed `/usr/bin/git` runner, repository identity/read service, canonical workspace path guard, and reusable real-Git fixture are implemented. All requested verification commands pass.

## RED / GREEN evidence

- RED 1: runner and path-guard suites failed because both production modules were absent.
- GREEN 1: runner argv/options/environment/buffer tests and negative/canonical path tests passed.
- RED 2: repository integration suite failed because `repository-inspector.ts` was absent.
- GREEN 2: real repository identity, read queries, status, diff, show, log, and worktree tests passed.
- RED 3: lexical traversal and a symlink alias to linked-worktree `.git` were accepted; both guard regressions now pass.
- RED 4: the shared path fixture did not yet create the documented external symlink; fixture regression now passes.
- RED 5: Git pathspec magic was accepted; it is now rejected before argv construction.

## Coverage and verification

- Added 20 unit tests and 25 integration tests (45 total).
- Final unit: 23 files, 258 tests passed.
- Final integration: 8 files, 71 tests passed.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed with zero warnings.
- `git diff --check`: passed.
- Covered exact runner argv/options/env, raw buffer output, spaces, bare/detached/unborn HEAD, nested identity, real SHA-1 and SHA-256 repositories, porcelain-v2 rename/untracked records, binary numstat, all five operation sentinels, bounded logs, `--` path separation, invalid OID/ref/pathspec/pathspec magic, worktree branch/locked/detached ownership, traversal, NUL/empty components, linked `.git`, common dir, symlink leaf/ancestor swaps, and nonexistent external leaves.

## Compatibility decisions

- Kept synchronous `createGitRepository()` and its immediate cleanup behavior while extending its returned fixture with the new async helpers.
- Added `createGitRepositoryFixture()` and `makePathGuardFixture()` without removing M1 exports.
- Kept `inspectExistingRepository()` and its M1 result/detached-HEAD behavior. Its production path now always constructs `GitCommandRunner`; the legacy injected executor is adapted through that same runner so existing unit-level dependency injection remains compatible.
- The new strict `GitReadService.inspectRepository()` rejects detached, bare, and unborn repositories as required.

## Files

- `src/worker/git/git-command-runner.ts`
- `src/worker/git/repository-inspector.ts`
- `src/worker/git/workspace-path-guard.ts`
- `src/worker/git/inspect-repository.ts`
- `tests/fixtures/git-repository.ts`
- `tests/unit/git/git-command-runner.test.ts`
- `tests/unit/git/workspace-path-guard.test.ts`
- `tests/integration/git/repository-inspector.test.ts`

## Self-review / concerns

- No blocking concerns. Paths are re-canonicalized on every authorization call; callers should still use the returned canonical path immediately because filesystem authorization and a later open cannot be made atomic through this interface alone.
- Git textual outputs are decoded as UTF-8, matching the controlled locale and current application string contracts; binary patch output uses the bounded buffer path before conversion.
