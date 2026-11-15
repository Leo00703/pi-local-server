# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and both packages use [Semantic Versioning](https://semver.org/).

Two packages are released from this repository: **`pi-local-server`** (tags `v*`) and **`opencode-local-server`** (tags `opencode-v*`).

## [Unreleased]

### Added
- Community files: contributing guide, security policy, code of conduct, issue forms, pull request template, Dependabot configuration.
- `docs/` pages for configuration, engines and security.

### Changed
- Reorganised the README around installation and a quick start; reference material moved to `docs/`.

## pi-local-server

### [0.2.1] - 2026-11-14

#### Changed
- The cache forgets servers that were not seen for 7 days, and keeps a single entry per machine (a server remembered at both its LAN and its Tailscale address is listed once).

### [0.2.0] - 2026-11-13

#### Added
- **Exact, always-current context windows**: the window is re-read from the server right before the agent uses a local model and when you select it, and Pi's active model is updated (with a notice) if the server was restarted with another context size.
- llama.cpp **router mode** support (per-model `--ctx-size` / preset args, loaded-model `/props`), **Strata** detection and **LM Studio** native API (`loaded_context_length`).
- Every model records where its context came from (`server`, `native-api`, `launch-args`, `model-max`, `estimated`); `/local-server status` flags the ones that are not verified.
- LAN and Tailscale machines are merged into one provider per machine; Tailscale peers are discovered from `tailscale status --json`, including the direct LAN address.
- `npm run live-check` and a Windows self-check script; CI on Linux, macOS and Windows.
- Releases are published to npm by GitHub Actions with provenance.

#### Fixed
- Windows `arp -a` output containing the machine's own addresses no longer produces duplicate providers.
- Discovery commands (`arp`, `tailscale`) have timeouts, and the LAN and tailnet sweeps run concurrently.
- LM Studio answering `200 {"error": …}` for unknown paths is no longer mistaken for Ollama.

### [0.1.1] - 2026-09-22

#### Fixed
- Installation instructions in the README.

### [0.1.0] - 2026-09-22

#### Added
- First release: Pi extension that discovers local LLM servers on localhost, LAN and Tailscale and registers them as providers.

## opencode-local-server

### [opencode 0.1.1] - 2026-11-14

#### Changed
- Same cache behaviour as `pi-local-server` 0.2.1 (7-day expiry, one entry per machine).

### [opencode 0.1.0] - 2026-11-13

#### Added
- First release: OpenCode plugin using the same discovery core. Works with OpenCode 1.x and 2.x (2.x refreshes every minute).

[Unreleased]: https://github.com/Leo00703/pi-local-server/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/Leo00703/pi-local-server/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Leo00703/pi-local-server/releases/tag/v0.2.0

[opencode 0.1.1]: https://github.com/Leo00703/pi-local-server/releases/tag/opencode-v0.1.1
[opencode 0.1.0]: https://github.com/Leo00703/pi-local-server/releases/tag/opencode-v0.1.0
