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

Releases are cut from a GitHub Release; merging to `main` never publishes. Publishing uses npm **trusted publishing
(OIDC)** — there is no `NPM_TOKEN` secret. The `publish` job proves its identity to npm through GitHub's OIDC token
(`id-token: write`) against a trusted publisher you configure on npm, and provenance is attached automatically.

### One-time setup (before the first release)

Do these once, in order:

1. **Publish `0.1.0` manually to create the package.** npm cannot attach a trusted publisher to a package that does
   not exist yet, so the first publish comes from a maintainer machine:

   ```bash
   npm login
   npm run check           # the gate must be green
   npm publish             # publishConfig.access is already "public"
   ```

   This first publish has no provenance; every CI release after it does.

2. **Attach the trusted publisher on npm.** On npmjs.com open the package
   (`https://www.npmjs.com/package/@nomeelnoj/pi-prompt-timer`) → **Settings → Trusted Publishing** → add a GitHub
   Actions publisher with:
   - Organization / user: `nomeelnoj`
   - Repository: `pi-prompt-timer`
   - Workflow filename: `publish.yml`
   - Environment: `release`

3. **Create the `release` GitHub environment.** Repo **Settings → Environments → New environment**, named exactly
   `release`. Optionally add a deployment tag rule (`v*`) and required reviewers. No secrets are needed.

4. **Protect `main`.** Require the `CI / check` status check, and SHA-pin Actions if desired.

5. **Enable private vulnerability reporting.** Repo **Settings → Code security → Private vulnerability reporting**, so
   the advisory link in `SECURITY.md` works.

### Cutting a release

1. On a branch, bump the version in **both** `package.json` and `package-lock.json` (they must stay in sync —
   `verify-package` asserts it):

   ```bash
   npm version <patch|minor|major> --no-git-tag-version
   ```

   `--no-git-tag-version` updates both files without creating a git tag; the tag comes from the GitHub Release.

2. Add a dated section to `CHANGELOG.md` for the new version: `## [X.Y.Z] - YYYY-MM-DD`.

3. Open a PR, confirm CI is green, and merge to `main`.

4. **(Optional) Rehearse.** Actions → **Publish to npm → Run workflow**, entering the tag `vX.Y.Z`. This runs the full
   gate, `npm audit`, the smoke test, and `npm publish --dry-run` — it never writes to npm.

5. **Create the GitHub Release.** Tag it exactly `vX.Y.Z` (the `package.json` version, `v`-prefixed), target the merged
   commit, and write release notes. Publishing a normal (non-prerelease) Release triggers `publish.yml`, which:
   - checks out the exact release commit,
   - re-runs `npm run check` and `npm audit --omit=dev`,
   - asserts the tag equals `v` + the `package.json` version,
   - runs `npm publish --provenance` from the `release` environment via OIDC.

   A **prerelease** Release runs validation but does not publish.

6. **Verify.** Confirm the new version, the provenance badge, and the tarball contents on npm, and that
   `pi install npm:@nomeelnoj/pi-prompt-timer` resolves the new version.

### If a release fails

- If validation fails before npm publishes, fix the problem, then delete the GitHub Release and its tag and re-create
  them (or push a corrected commit and a fresh tag).
- If a bad version already reached npm, do **not** unpublish it — deprecate it
  (`npm deprecate @nomeelnoj/pi-prompt-timer@X.Y.Z "reason"`) and ship a corrected patch release.

---

Repository conventions here — the CI gate, package-content verification, and clean-install smoke test — follow the
pattern established by [pi-copy-code](https://github.com/penumbral-labs/pi-copy-code) (MIT), reimplemented for this
package.
