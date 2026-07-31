# Branchestra

Branchestra is an open-source, local-first macOS desktop app for working with
Claude Code and OpenAI Codex in one shared chat.

The goal is simple: add a local Git project, mention `@Claude` or `@Codex`, and
let the selected coding agent read the room context, work in the project, and
stream its progress back into the conversation.

> [!IMPORTANT]
> Branchestra is in early development. The persistent desktop foundation and
> guarded Git task engine are implemented, but real Claude Code and Codex
> adapters are not connected on `main` yet. It is not ready for daily use or
> public installation.

## Why Branchestra?

Claude Code and Codex are both useful coding agents, but they normally live in
separate terminal sessions. Branchestra is intended to provide:

- one persistent room shared by the user, Claude, and Codex;
- explicit task routing through `@Claude` and `@Codex`;
- live task output in a unified timeline;
- local project and conversation storage;
- use of official, user-installed CLIs and their existing sign-in state;
- no hosted Branchestra backend and no storage of provider credentials.

Local-first does not mean local model inference. Context selected for an agent
is still sent through that provider's official CLI and is governed by the
provider's terms and data policies.

## Current status

Implemented on `main`:

- Electron + React + TypeScript desktop shell;
- adding an existing local Git repository;
- persistent projects, rooms, and messages backed by SQLite;
- a unified timeline with restart-safe replay;
- isolated renderer, typed preload API, and supervised utility worker;
- approval-first `@Claude` / `@Codex` task creation;
- isolated agent worktrees, immutable checkpoints and two review rounds;
- verified candidates with bound diff/test hashes and exact final approval;
- ff-only/CAS merge protection plus explicit crash-recovery previews;
- a trusted Task Inspector for scope, merge, cancellation, and recovery actions;
- unit, integration, and mock-provider Electron end-to-end coverage.

Next MVP slice:

- detect authenticated local `claude` and `codex` executables;
- provide the current room transcript as shared context;
- stream structured CLI output into the timeline;
- implement health-gated real Provider adapters without moving Git authority
  outside the worker task engine.

The longer-term design includes signed macOS builds and Homebrew Cask
installation.

## Development

### Requirements

- macOS 12 or newer
- Node.js `24.18.0`
- pnpm `11.15.1`

### Run locally

```bash
git clone https://github.com/jason8607/branchestra.git
cd branchestra
corepack enable
pnpm install
pnpm dev
```

### Checks

```bash
pnpm test
pnpm test:e2e
pnpm typecheck
pnpm lint
pnpm build
```

## Architecture

```text
Electron Renderer (React)
          |
     typed preload API
          |
      Electron Main
          |
    utility-process worker
       |             |
    SQLite       local Git project
```

The renderer has no direct Node.js, filesystem, shell, Git, or database access.
The utility worker owns persistent application state and privileged project
operations.

## Provider and billing boundary

Branchestra will not implement its own Claude or ChatGPT login flow. Users must
install and sign in to the official CLIs outside the app. Provider adapters
must not store OAuth tokens or silently fall back to an API key.

Provider plan eligibility, limits, and billing behavior are controlled by
Anthropic and OpenAI and may change independently of Branchestra.

## Project documentation

- [Product design](docs/superpowers/specs/2026-07-21-branchestra-design.md)
- [Implementation roadmap](docs/superpowers/plans/2026-07-21-branchestra-roadmap.md)
- [Desktop foundation plan](docs/superpowers/plans/2026-07-21-branchestra-foundation.md)
- [Git task engine plan](docs/superpowers/plans/2026-07-21-branchestra-git-task-engine.md)

## Contributing

The project is still establishing its first usable MVP. Issues and focused pull
requests are welcome, but expect internal contracts and architecture to change
before the first release.

## License

MIT
