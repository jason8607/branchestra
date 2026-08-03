# Local self-use macOS build

**Goal:** Produce an Apple Silicon Branchestra app and ZIP that can be installed locally without Developer ID signing or notarization, while keeping public-release policy unchanged and private Provider enablement fail-closed.
**Why planning is required:** The build changes executable Provider policy and macOS distribution security behavior.
**Acceptance:** `pnpm package:local` produces an unsigned arm64 `.app` and ZIP under `release/local`; the app contains no bundled Provider executable, credential, source map, or public-policy override; local Provider mode is fixed at compile time, still enforces the checked-in exact support matrix and Codex config lock, and cannot be enabled from Renderer input or an installed app's environment; public package commands retain signing and notarization requirements.

### Outcome 1: Separate private-local policy from public policy
- Work: Add a compile-time-only local-build marker and a Node-side effective Provider policy used by worker health and registry creation. Public builds continue to derive solely from `config/provider-policy.json`; local builds may bypass only the public distribution-policy decision, not executable discovery, exact version checks, authentication checks, process isolation, or the Codex config lock.
- Risks/open questions: The installed Claude `2.1.220` and Codex `0.145.0` are newer than the reviewed versions, so they must remain unavailable until compatible exact CLIs and the reviewed Codex lock exist.
- Verify: `pnpm exec vitest run tests/unit/providers tests/integration/providers/provider-health-service.test.ts tests/integration/electron-vite-config.test.ts`

### Outcome 2: Reproducible unsigned local package
- Work: Add a local-only electron-builder configuration path and `package:local` command for macOS arm64. Build the app and ZIP with signing discovery, forced signing, and notarization disabled, no publishing, a distinct bundle identifier, and Provider dependencies/resources included only when required by the compile-time private-local mode.
- Risks/open questions: macOS may require the user to confirm opening an unsigned local app; this build is not suitable for redistribution.
- Verify: `pnpm package:local`

### Outcome 3: Artifact and regression evidence
- Work: Extend tests and package-content verification for the local artifact, document its scope and compatibility stop conditions, and run the full static, unit, integration, security, build, and packaged-app checks that do not require external Provider credentials.
- Verify: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:security && pnpm build && pnpm verify:package -- release/local/mac-arm64/Branchestra.app`
