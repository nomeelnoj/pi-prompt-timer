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

The overlay lists one row per turn — the agent's response time and a preview of your prompt — with idle gaps longer than
30 seconds shown as `waiting` rows (red once they exceed the 5-minute cache TTL). An in-progress turn appears as a live
row at the bottom.

When the overlay is open:

- `↑` / `↓` or `j` / `k` — move through history
- `→` or `w` — open the "Write to file" panel
- `esc` or `q` — close

### Write history to a file

From the overlay, `→` or `w` opens a titled "Write to file" panel:

- **Auto path** — `.scratch/timer-<date>[-session].md`, relative to the current working directory; press `enter` to
  write immediately.
- **Choose your own location** — opens an input pre-filled with the auto path so you can edit the destination.

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

- Use the [bug report form](https://github.com/nomeelnoj/pi-prompt-timer/issues/new?template=bug_report.md) for
  reproducible problems.
- See [CHANGELOG.md](CHANGELOG.md) for release history.

## Package shape

Pi loads the TypeScript source extension directly. The npm tarball contains only `package.json`, the source extension,
`README.md`, `CHANGELOG.md`, and `LICENSE`; it has no runtime dependencies or install scripts.

## License

MIT
