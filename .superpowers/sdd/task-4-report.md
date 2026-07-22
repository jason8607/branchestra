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
- Git textual outputs are decoded as strict UTF-8, matching the controlled locale and current application string contracts; invalid bytes fail closed, and binary patch output uses the bounded buffer path before conversion.

## Independent-review fix round

### Status and decisions

- All Critical and Important findings in `task-4-review.md` are fixed.
- The runner now uses `--no-pager`, command-priority `core.fsmonitor=false` and `log.showSignature=false`, `GIT_OPTIONAL_LOCKS=0`, and a fixed 15-second timeout with `SIGKILL`. Test-only timeout overrides remain bounded to 1–60,000 ms.
- Every diff-producing read uses `--no-ext-diff --no-textconv`; repository-configured fsmonitor, external-diff, and textconv helpers are covered by a real sentinel script that must not execute.
- `status` re-observes and canonicalizes both top-level and common-dir identities before reading porcelain. `inspectRepository` accepts a stored root binding and rejects a different observed top-level.
- Exact OID validation is shared by M1 and M2 and accepts only 40 or 64 lowercase hexadecimal characters.
- Branch refs deliberately retain the plan's conservative ASCII allowlist. Within it, validation rejects empty/dot-prefixed/dot-suffixed components, `..`, `@{`, `.lock` component endings, malformed slashes, controls, non-ASCII, and non-branch namespaces.
- Log reads first obtain a NUL-framed validated OID list, then fetch each commit's four metadata fields independently. Exact field count, OID equality, parents, and semantic ISO date validity are checked; `0x1e`/`0x1f` subject bytes no longer collide with framing.
- Raw buffer decoders now use fatal UTF-8 validation and return `GIT_OUTPUT_INVALID_UTF8` instead of replacement paths. APFS would not permit constructing a real invalid-UTF-8 filename in the test environment, so the regression injects raw invalid porcelain bytes at the parser boundary.

### RED / GREEN evidence

- RED: runner option assertions lacked fsmonitor/signature neutralization, optional-lock suppression, and timeout/kill; GREEN after hardening both text and buffer execution paths.
- RED: M1 accepted 41- and 63-character OIDs and the shared validator module was absent; GREEN with 27 new boundary unit cases.
- RED: two-repository inspect/status mismatches were accepted; GREEN after canonical top-level/common-dir re-observation.
- RED: configured external diff executed and status changed index mtime; GREEN with helper sentinel absent and index bytes/mtime unchanged with no lock file.
- RED: separator bytes corrupted log framing; GREEN with collision-safe per-OID metadata reads.
- RED: an impossible authored timestamp passed shaped-field validation; GREEN after semantic date validation.
- RED: invalid UTF-8 path bytes were decoded with replacement; GREEN with stable rejection.
- RED: a configured executable alias ran for ten seconds; GREEN with a real timeout/kill in under two seconds.

### Final verification after fixes

- Added 27 unit and 8 integration regressions in the fix round.
- Focused unit: 24 files, 285 tests passed.
- Focused integration: 8 files, 79 tests passed.
- Full unit: 24 files, 285 tests passed.
- Full integration: 8 files, 79 tests passed.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed with zero warnings.
- `git diff --check`: passed.
