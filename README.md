# @nomeelnoj/pi-prompt-timer

A [Pi](https://pi.dev/) package that shows live prompt timing: a footer clock that tracks the prompt-cache TTL and a
`/timer` history overlay of how long each turn took.

`@nomeelnoj/pi-prompt-timer` adds an always-visible footer timer and a `/timer` command (plus a `ctrl+alt+t` shortcut).
While the agent works, the footer shows elapsed thinking time. While you are idle — at the prompt, during a long tool
run, or while answering a question — it counts up toward the prompt-cache TTL, turning amber at 4 minutes and red at 5.
The `/timer` overlay lists every turn's response time, flags idle gaps as "waiting" rows, and can write the history to a
Markdown file.

## Prerequisites

- Node.js 22.19.0 or newer
- npm 11.10.0 or newer when developing or releasing from a checkout
- Pi (tested against Pi 0.84.4; older releases are untested)

Core Pi packages remain wildcard peer dependencies so the package uses the Pi installation that loads it. The
`latest-pi` CI lane checks current Pi releases on an advisory basis.

## Install

From npm:

```bash
pi install npm:@nomeelnoj/pi-prompt-timer
```

Then reload Pi:

```text
/reload
```

For a one-off run without installing:

```bash
pi -e npm:@nomeelnoj/pi-prompt-timer
```

You can also load a checkout directly:

```bash
git clone https://github.com/nomeelnoj/pi-prompt-timer.git
cd pi-prompt-timer
npm ci
pi -e "$(pwd)"
```

## Usage

### Footer timer

The footer updates every second and reflects one of three states:

- **Agent working** — elapsed time since the run started:

  ```text
  ⏱  1:23  started 14:32:05
  ```

- **Idle / waiting** — time since the last response, colored by proximity to the prompt-cache TTL:

  | Elapsed | Color | Example |
  |---------|-------|---------|
  | < 4 min | dim | `⌛ 2:45  @14:33:28   last: 1:23` |
  | 4–5 min | amber | `⌛ 4:12  · cache TTL expires in 0:48` |
  | ≥ 5 min | red | `⌛ 5:03  ⚠ cache TTL expired` |

- **Fresh session** — a single `—` until the first turn completes.

The idle clock is anchored to the last completed provider response, so it counts correctly whether you are idle at the
prompt, waiting on a long-running tool, or answering a blocking question. It is restored from the session transcript on
`/reload`, so reloading plugins never resets the cache clock; only a brand-new session (`/new`) starts empty.

### History overlay

Open the per-turn history with the command or shortcut:

```text
/timer
```

```text
ctrl+alt+t
```

The overlay is a centered floating modal with a header strip of two tabs — **History** and **Write to file** — modeled
on pi-copy-code's response tabs. The **History** tab lists one row per turn (the agent's response time and a preview of
your prompt), with idle gaps longer than 30 seconds shown as `waiting` rows (red once they exceed the 5-minute cache
TTL). An in-progress turn appears as a live row at the bottom.

When the overlay is open:

- `↑` / `↓` or `j` / `k` — move through history
- `→` / `tab` — switch to the **Write to file** tab (`←` / `tab` switches back)
- `esc` or `q` — close

### Write history to a file

Switch to the **Write to file** tab (`→` or `tab`) and pick an option with `↑` / `↓`, then `enter`:

- **Auto path** — `.scratch/timer-<date>[-session].md`, relative to the current working directory; press `enter` to
  write immediately.
- **Choose a relative path** — opens an input pre-filled with the auto path. The destination must be **relative to the
  project directory**; absolute paths and `../` escapes are rejected. The save confirmation shows the full resolved
  path so the destination is unambiguous.

The file records each turn's timestamp, response duration, and prompt preview, with `waiting` markers for idle gaps. The
`.scratch/` directory is created automatically if it does not exist.

### Cache-TTL clock during questions

While a blocking prompt or overlay is open (for example an `ask_user_question` questionnaire), the footer is covered by
that overlay, so the cache-TTL countdown is mirrored into the terminal title bar — which no overlay can occlude. The
title is restored when the prompt closes. Set `MIRROR_TO_TITLE_DURING_PROMPTS` to `false` at the top of the extension to
disable this.

## How the cache clock works

The prompt cache is server-side state whose TTL counts down from the last request that touched it. Any gap with no API
traffic — idling at the prompt, a long-running tool, or waiting for a human answer — expires it identically. The timer
therefore anchors its countdown to the last completed provider response rather than to any single "idle" event. The
default TTL is 5 minutes (`CACHE_TTL_MS`); adjust the constant if your provider tier uses a different window.

## Support and contributing

- Use the [bug report form](https://github.com/nomeelnoj/pi-prompt-timer/issues/new?template=bug_report.yml) for
  reproducible problems, or the
  [feature request form](https://github.com/nomeelnoj/pi-prompt-timer/issues/new?template=feature_request.yml) for
  focused proposals.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
- Read [CONTRIBUTING.md](CONTRIBUTING.md) before sending a pull request.
- See [CHANGELOG.md](CHANGELOG.md) for release history.

## Package shape

Pi loads the TypeScript source extension directly. The npm tarball contains only `package.json`, the source extension,
`README.md`, `CHANGELOG.md`, and `LICENSE`; it has no runtime dependencies or install scripts.

## License

MIT

## Credits

This package's repository conventions — the CI `check` gate, the package-content verification and clean-install smoke
test (`scripts/`), the GitHub Actions CI/publish workflows, and the community-health files — follow the pattern
established by [pi-copy-code](https://github.com/penumbral-labs/pi-copy-code) by Aaron Small (MIT), reimplemented and
adapted for this package. A few conventional config files (`.github/dependabot.yml`, `.gitignore`, and the
`.claude/CLAUDE.md` → `AGENTS.md` import) are the ecosystem-standard boilerplate shared with that project.
