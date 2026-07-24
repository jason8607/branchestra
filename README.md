# Branchestra

Branchestra is an open-source, local-first macOS desktop app for working with
Claude Code and OpenAI Codex in one shared chat.

The goal is simple: add a local Git project, mention `@Claude` or `@Codex`, and
let the selected coding agent read the room context, work in the project, and
stream its progress back into the conversation.

> [!IMPORTANT]
> Branchestra is in early development. The persistent desktop chat foundation
> is implemented, but real Claude Code and Codex execution is not connected on
> `main` yet. It is not ready for daily use or public installation.

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
- unit, integration, and Electron end-to-end tests for the foundation.

Next MVP slice:

- detect authenticated local `claude` and `codex` executables;
- route `@Claude` and `@Codex` mentions;
- provide the current room transcript as shared context;
- stream structured CLI output into the timeline;
- allow one agent at a time to modify the selected project and run tests;
- cancel a running task and report its final Git change summary.

The longer-term design includes isolated worktrees, checkpoints, cross-review,
approval-bound merges, crash recovery, signed macOS builds, and Homebrew Cask
installation. These are not part of the first usable MVP.

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

## Contributing

The project is still establishing its first usable MVP. Issues and focused pull
requests are welcome, but expect internal contracts and architecture to change
before the first release.

## License

MIT
