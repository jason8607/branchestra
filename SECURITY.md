# Security

Report vulnerabilities privately through the repository security-advisory channel. Do not include credentials, private source, raw Provider transcripts, or customer repositories in a report.

Branchestra keeps Renderer, Preload, Main, Worker, Provider runner, external CLI, and Git responsibilities separate. Provider and repository content is untrusted data. The Renderer has no Node, filesystem, database, Git, or shell primitive. External links require an explicit HTTPS-only native confirmation.

Managed Git worktrees provide concurrency isolation and recovery checkpoints; they are not a security boundary against a malicious repository. Provider processes are restricted by approved capability profiles and verified process identity. Public builds never bundle Provider executables or accept API-key/custom-endpoint fallback.
