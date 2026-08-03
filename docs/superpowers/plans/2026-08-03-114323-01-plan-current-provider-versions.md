# Current Claude Code and Codex version support

**Goal:** Make the private local Branchestra build recognize and safely use the user's installed Claude Code `2.1.220` and Codex `0.145.0` CLIs.
**Why planning is required:** This changes an executable trust boundary and the version-bound Codex configuration lock.
**Acceptance:** The exact current Claude and Codex tuples are present in the checked-in support matrix for arm64 and x64; unreviewed versions still fail closed; Codex `0.145.0` is accepted only with a reviewed, hash-pinned, version-matching lock packaged in the private local app; public Provider policy remains disabled; unit, integration, security, build, package-content, and real local Claude and Codex SDK smoke checks pass.

### Outcome 1: Add exact current-version compatibility
- Work: Write failing tests for the installed versions, then add Claude Code `2.1.220` and Codex `0.145.0` rows without permitting ranges or arbitrary future versions. Keep the currently pinned Provider SDKs unless a compatibility test proves an SDK upgrade is required.
- Risks/open questions: A CLI patch can change auth output or SDK protocol behavior even when discovery succeeds; exact tuple tests and real smoke cover those boundaries.
- Verify: `pnpm exec vitest run tests/unit/providers/support-matrix.test.ts tests/unit/providers/executable-discovery.test.ts tests/integration/providers/provider-health-service.test.ts`

### Outcome 2: Replace the stale Codex lock with a reviewed `0.145.0` lock
- Work: Make lock validation compare the detected CLI against the strict manifest rather than a source-code literal, generate the lock with the installed Codex CLI using the official OpenAI/ChatGPT provider configuration, review its complete contents, and pin its path, byte size, and SHA-256 in the manifest. Extend packaging and package verification to include the private-local lock while leaving public release evidence and policy untouched.
- Risks/open questions: The lock must contain no token, credential, custom endpoint, MCP server, hook, notifier, or version-mismatch escape hatch. Generation must not copy credentials into the repository or temporary config directory.
- Verify: `pnpm exec vitest run tests/unit/providers/codex-config-lock.test.ts tests/integration/package-policy.test.ts && pnpm test:security`

### Outcome 3: Build and validate the corrected local app
- Work: Run the full project checks, package the private-local arm64 app/ZIP, inspect its Provider resources, and run real executable/auth probes against `/opt/homebrew/bin/claude` and `/Users/jason8607/.local/bin/codex`.
- Risks/open questions: Provider account state can differ between a sandboxed shell and the installed app because the macOS keychain is unavailable in the former; the final real smoke must therefore run with normal user keychain access.
- Verify: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:security && pnpm build && pnpm package:local && pnpm verify:package -- release/local/mac-arm64/Branchestra.app`
