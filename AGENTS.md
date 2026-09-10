# Repository instructions

## Purpose

`pi-prompt-timer` is a focused Pi package that surfaces three live timing elements during a conversation:
a thinking-timer widget above the editor, an idle-timer footer that warns at the 5-minute cache TTL, and
small timestamp stamps in the transcript. Keep it small and purpose-built.

## Architecture

- Pi loads `extensions/prompt-timer/index.ts` directly from the package manifest; do not add compiled output.
- All state is module-scoped inside the single default-export factory.
- A single 1-second `setInterval` drives all live surfaces; started on `session_start`, stopped cleanly on
  `session_shutdown`.
- `tui.requestRender()` handles are captured from the footer and widget component factories and stored in
  module-level variables.
- No runtime dependencies. Pi core packages stay wildcard peer dependencies.

## Development

Requires Node.js 22.19.0 or newer and npm 11.10.0 or newer.

```bash
npm ci               # install dev dependencies
npm run typecheck    # TypeScript type-check (no emit)
npm run check        # full gate: typecheck + verify-package + smoke-package
```

Test interactively:

```bash
pi -e "$(pwd)"
```

### What `npm run check` does

| Script | What it checks |
|--------|---------------|
| `typecheck` | TypeScript compilation |
| `verify-package` | Tarball contents match the `files` allowlist; no runtime deps; no install scripts |
| `smoke-package` | Packs a real tarball, installs it with pinned peers, loads with jiti, asserts all five event handlers and the entry renderer are registered |

## Release process (when public and npm-published)

1. Bump `version` in `package.json` and `package-lock.json`.
2. Update `CHANGELOG.md`.
3. Commit on a branch, open a PR, merge to `main`.
4. Create a GitHub Release with tag `v<version>` (e.g. `v0.1.1`).
5. The `publish.yml` workflow validates the tag matches the package version, re-runs the full check
   gate, and publishes to npm with provenance.

Before step 4, you can dry-run the publish workflow via `workflow_dispatch` with the expected tag.

Publishing uses npm trusted publishing (OIDC) — there is no `NPM_TOKEN` secret. The `publish` job
authenticates through GitHub OIDC (`id-token: write`) against a trusted publisher configured on npm for
this repo, the `publish.yml` workflow, and the `release` environment, and provenance is automatic. See
`CONTRIBUTING.md` for the one-time trusted-publisher setup (including the first `0.1.0` publish).

## Repository hygiene

- Keep temporary agent output under `.scratch/`; it is not committed.
- Do not commit `.pi/`, `.pi-subagents/`, node_modules, or package archives.
- Format Markdown at 120 columns.
- Keep workflow actions pinned to immutable commit SHAs with version comments.
- Repository conventions (the CI gate, package-content verification, and clean-install smoke test) follow the pattern
  established by [pi-copy-code](https://github.com/penumbral-labs/pi-copy-code) (MIT), reimplemented here.
- Never publish, push tags, create releases, or change repository settings without explicit maintainer
  approval.
