# Contributing

Thanks for helping improve `@nomeelnoj/pi-prompt-timer`. This is a small, single-file Pi extension; changes should
keep it that way.

## Develop

Requires Node.js 22.19.0+ and npm 11.10.0+.

```bash
git clone https://github.com/nomeelnoj/pi-prompt-timer.git
cd pi-prompt-timer
npm ci
npm run check
```

Pi loads `extensions/prompt-timer/index.ts` directly — there is no build step. Keep runtime dependencies at zero and Pi
core packages as wildcard peers; the dev versions are pinned to the tested Pi baseline. Exercise real changes in a
terminal with `pi -e "$(pwd)"` and note the terminal, OS, and Pi version in your pull request.

## The `check` gate

`npm run check` runs, in order:

- `typecheck` — `tsc --noEmit`.
- `test` — Node's test runner over `test/*.test.mjs` (pure-helper unit tests).
- `verify-package` — asserts the packed tarball is exactly the five declared files with no runtime deps or install
  scripts.
- `smoke-package` — packs, installs into a temp project with the pinned peers, loads the packed source via jiti, and
  checks the handlers, `/timer` command, and `ctrl+alt+t` shortcut register.

Keep pull requests focused, and update `README.md` and `CHANGELOG.md` when behavior changes.

## Releasing

Releases are cut from a GitHub Release; merging to `main` never publishes.

1. Publishing uses npm trusted publishing (OIDC): configure a trusted publisher on npm for this repo, the
   `publish.yml` workflow, and the `release` environment. No `NPM_TOKEN` is used. npm requires the package to exist
   first, so the initial `0.1.0` is published once from a maintainer machine (`npm publish`); every release after that
   runs through CI with no secret.
2. Bump `version` in `package.json` and `package-lock.json`, update `CHANGELOG.md`, and merge.
3. Publish a GitHub Release tagged `vX.Y.Z`. The workflow re-runs the gate, verifies the tag matches the package
   version, and publishes with provenance. A prerelease validates but does not publish. You can rehearse via the
   workflow's manual `workflow_dispatch` (dry-run) first.

---

Repository conventions here — the CI gate, package-content verification, and clean-install smoke test — follow the
pattern established by [pi-copy-code](https://github.com/penumbral-labs/pi-copy-code) (MIT), reimplemented for this
package.
