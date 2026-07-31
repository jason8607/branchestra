# Privacy

Branchestra stores projects, rooms, messages, task state, approvals, context hashes, Provider health metadata, and redacted bounded logs locally in its application-data directory. Git repositories and retained recovery worktrees remain on the local filesystem.

When an Agent runs, the selected context—including relevant chat, code, diffs, test summaries, and read-only tool results—is sent by the separately installed official CLI to that Provider. Credentials and raw authentication output are neither stored in SQLite nor exposed to the Renderer.

Branchestra has no telemetry, crash upload, or silent updater. Diagnostic export is user initiated, lists its included metadata before saving, excludes source bodies/raw diffs/raw Provider payloads/environment values, redacts secrets, and creates an owner-only gzip JSON file.

Data management is explicit and preview-bound. Room and project metadata removal requires an exact typed confirmation and never deletes the Git repository, branches, Git objects, Provider sessions, or filesystem backups. A dirty managed worktree requires a separate confirmation and is moved into the worker-owned recovery directory before Git unregisters it; no cancellation, failure, or quit path performs that archive automatically.
