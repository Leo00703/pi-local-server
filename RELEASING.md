# Releasing

Two npm packages are published from this repository, each by its own git tag:

| Package | Folder | Tag | Workflow job |
|---|---|---|---|
| `pi-local-server` | repository root | `v<version>` (e.g. `v0.2.0`) | `pi-local-server` |
| `opencode-local-server` | `opencode/` | `opencode-v<version>` (e.g. `opencode-v0.1.0`) | `opencode-local-server` |

The workflow (`.github/workflows/publish.yml`) refuses to publish when the tag does not match the `version` in the package's `package.json`, and runs the typecheck and the tests first. Publishing uses npm trusted publishing (OIDC), so no token is stored in the repository.

## Normal release

1. Bump `version` in `package.json` (Pi) and/or `opencode/package.json` (OpenCode), commit, push to `main` and wait for CI to pass.
2. Tag and push the tag:

   ```bash
   git tag v0.2.0 && git push origin v0.2.0                   # pi-local-server
   git tag opencode-v0.1.0 && git push origin opencode-v0.1.0 # opencode-local-server
   ```

The OpenCode package is the bundled plugin (`opencode/dist/index.js`, built by `npm run build:opencode`, shared `core/` included), so it has no runtime dependency of its own.

## First publish of `opencode-local-server`

npm only lets you configure trusted publishing for a package that already exists, so the very first release is done by hand, once:

```bash
npm ci
npm run build:opencode
cd opencode
npm publish          # log in with `npm login` first
```

Then, on npmjs.com, open the package → Settings → Trusted Publisher → GitHub Actions, and set: repository `Leo00703/pi-local-server`, workflow `publish.yml`. From then on a pushed `opencode-v*` tag publishes it. (`pi-local-server` is already set up this way.)

## Check before tagging

```bash
npm run typecheck && npm test
npm pack --dry-run                       # pi-local-server: core/ + extensions/ + README + LICENSE
npm run build:opencode && (cd opencode && npm pack --dry-run)   # opencode-local-server: dist/ + README + LICENSE
```

## After releasing

- Pi: `pi install npm:pi-local-server` / `pi update npm:pi-local-server`.
- OpenCode: add `"plugin": ["opencode-local-server"]` to `~/.config/opencode/opencode.jsonc` (or copy `dist/index.js` to `~/.config/opencode/plugins/local-server.js`).
