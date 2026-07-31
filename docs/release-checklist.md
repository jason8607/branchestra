# Release Checklist

- [ ] Tag is stable semver and points to a green `main` commit.
- [ ] Provider policy review is at most 30 days old; enabled flags match its decisions.
- [ ] Anthropic written approval exists if and only if public Claude support is enabled.
- [ ] Unit, integration, security, Electron E2E, and packaged recovery tests pass.
- [ ] arm64 and x64 artifacts pass codesign, stapler, Gatekeeper, package scan, and native smoke.
- [ ] DMG/ZIP checksums match GitHub assets and the Homebrew Cask.
- [ ] Homebrew audit plus clean-machine install and upgrade pass.
- [ ] Assets contain no credentials, Provider executable, source map, repository, or raw fixture.
- [ ] Every public Provider has current real-Provider smoke evidence; unsupported Providers are disabled.
