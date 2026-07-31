# Contributing

Use Node.js 24.18.0 and pnpm 11.15.1. Install exact locked dependencies, then run `pnpm lint`, `pnpm typecheck`, `pnpm test`, the explicit security matrix, `pnpm build`, and Electron E2E tests.

Public CI uses mock Provider SDK factories and sanitized event fixtures only. Never commit consumer OAuth material, auth output, tokens, private prompts, source repositories, or unredacted Provider fixtures. Provider/CLI support changes require exact version pins, current native enforcement evidence, and a reviewed policy decision.

Release maintainers use actionlint 1.7.12 and must verify its version before tagging. Public Claude subscription support remains disabled until repository-tracked written Anthropic approval and current enforcement reports pass the release gate.
