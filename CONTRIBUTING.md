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

Sign your commits (`git commit -s`, DCO) and keep them in the Conventional Commit style.

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

Releases are cut from a GitHub Release; merging to `main` never publishes. Publishing uses npm trusted publishing
(OIDC) through the `release` environment — there is no `NPM_TOKEN`, and provenance is attached automatically. (The
one-time trusted-publisher and environment setup is a maintainer step done before the first release.)

To cut a release:

1. Bump the version in `package.json` and `package-lock.json` (`npm version <patch|minor|major> --no-git-tag-version`)
   and add a dated `CHANGELOG.md` entry, then merge to `main`.
2. Publish a GitHub Release tagged exactly `vX.Y.Z` (matching the package version). `publish.yml` re-runs the check
   gate, asserts the tag matches, and publishes with provenance. A prerelease validates without publishing, and the
   workflow's manual dispatch does a dry run.
3. Confirm the new version and provenance on npm.

---

Repository conventions here — the CI gate, package-content verification, and clean-install smoke test — follow the
pattern established by [pi-copy-code](https://github.com/penumbral-labs/pi-copy-code) (MIT), reimplemented for this
package.
