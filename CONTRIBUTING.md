# Contributing

Thanks for taking the time to help. This project is small on purpose: one discovery core, two thin adapters (a Pi extension and an OpenCode plugin).

## Ways to help

- **Report a server that is not detected, or a wrong context window.** This is the most useful thing you can do. Open a [bug report](https://github.com/Leo00703/pi-local-server/issues/new/choose) and include the engine, its version and the output of `/local-server status`. If you can, attach the *shape* of the `/v1/models` and `/props` (or native API) answers with addresses and keys removed.
- **Try it on an engine or OS that is not live-tested yet** (see the table in the [README](README.md#supported-engines)) and tell us what happened, good or bad.
- **Send a pull request.** Small and focused is best.

## Layout

```
core/                       discovery, detectors, context windows, cache (no Pi/OpenCode imports)
extensions/pi-local-server/ Pi adapter
opencode/                   OpenCode plugin (its own npm package, bundled with esbuild)
test/                       node:test suites (run with tsx) + anonymised fixtures in test/fixtures
scripts/                    live-check.mts (what discovery sees on this machine), windows-check.ps1
docs/                       configuration and per-engine notes
```

Anything that decides *what* a server is or *which* context it runs with belongs in `core/`, so both adapters stay in sync.

## Development

Requires Node.js 22.19 or newer.

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # unit tests, no network access needed
npm run live-check  # read-only: prints what discovery finds on this machine
npm run build:opencode
```

To try the Pi extension without touching your own Pi settings:

```bash
PI_CODING_AGENT_DIR="$(mktemp -d)" pi -ne -e ./extensions/pi-local-server/index.ts --list-models local-
```

## Ground rules

- **Tests for every detector or context change.** Add a fixture under `test/fixtures/` (recorded answers, anonymised) and a test that uses it. Server behaviour is the whole product, so it must be pinned down.
- **Never trust a number that the server did not give.** If a context window is estimated, mark it as such (`contextSource`), never present it as exact.
- **No personal data in the repository.** Fixtures, tests and docs must not contain real IP addresses, hostnames, tailnet names, API keys or model paths from your machines. Use `192.0.2.x`, `100.64.0.x` or `example.ts.net` placeholders.
- **Keep the security model** described in the README: only private addresses are probed automatically, API keys only go where you configured them, redirects are never followed.
- Keep it dependency-free at runtime. Dev dependencies are fine.

## Pull requests

1. Fork and branch from `main` (`fix/…`, `feat/…`, `docs/…`).
2. Make the change, add tests, and run `npm run typecheck && npm test`.
3. Update `CHANGELOG.md` under *Unreleased* for anything a user can notice.
4. Open the PR and fill in the template. CI runs on Linux, macOS and Windows.

Releases are made by the maintainer, see [RELEASING.md](RELEASING.md).

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE) and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).
