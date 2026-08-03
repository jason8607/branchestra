# Branchestra

Branchestra is a local-first macOS workspace for coordinating coding agents through explicit task scopes, durable approvals, isolated Git worktrees, review checkpoints, and a final human-controlled merge.

## Install on macOS

The public Cask is not published yet. Release remains gated on native arm64/x64 Provider enforcement evidence, Developer ID signing, notarization, and Gatekeeper verification. Once released, installation will use the repository-owner-specific Homebrew tap documented by the release workflow.

## Private local macOS build

On an Apple Silicon Mac, `pnpm package:local` creates an unsigned, unnotarized app and ZIP in `release/local`. This artifact is for the local account only and is not suitable for redistribution. macOS may require confirming the first launch from Finder's **Open** command.

The local build does not change `config/provider-policy.json`. It enables the external subscription Provider paths only through a compile-time marker, while retaining exact CLI-version discovery, subscription-auth checks, process isolation, and the Codex config-lock requirement. This release reviews only Claude `2.1.206` and Codex `0.144.6`; other installed versions remain unavailable, and the support matrix must not be weakened to bypass that check.

Supported Provider CLIs are installed and authenticated separately. Branchestra does not accept API keys or custom Provider endpoints and does not bundle Provider executables.

## Development

Use Node.js 24.18.0 and pnpm 11.15.1, then run `pnpm install --frozen-lockfile` and `pnpm verify:all`. The aggregate gate includes typecheck, lint, unit/integration/security tests, source Electron E2E, an unsigned packaged-ASAR recovery journey, package-content policy, and license inventory.
