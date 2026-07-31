# Branchestra

Branchestra is a local-first macOS workspace for coordinating coding agents through explicit task scopes, durable approvals, isolated Git worktrees, review checkpoints, and a final human-controlled merge.

## Install on macOS

The public Cask is not published yet. Release remains gated on native arm64/x64 Provider enforcement evidence, Developer ID signing, notarization, and Gatekeeper verification. Once released, installation will use the repository-owner-specific Homebrew tap documented by the release workflow.

Supported Provider CLIs are installed and authenticated separately. Branchestra does not accept API keys or custom Provider endpoints and does not bundle Provider executables.

## Development

Use Node.js 24.18.0 and pnpm 11.15.1, then run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, and `pnpm test`.
