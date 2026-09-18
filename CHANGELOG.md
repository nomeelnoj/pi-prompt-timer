# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.0] - 2026-09-18

### Added

- **Rewarm cost in history**: a turn whose prompt arrived after the 5-minute cache TTL expired now carries a
  `rewarm` badge in the `/timer` history overlay, showing what re-establishing the cache cost. Uses the metered
  cache-write charge reported by the provider when available (`rewarm $0.09`), falling back to an estimate from
  token counts and the model's rates (`rewarm ~$0.09 (est.)`) for providers with implicit caching or no reported
  cache-write cost. A `Session rewarm total` row is pinned to the bottom of the overlay, marked `(est.)` if any
  contributing turn was estimated. The session's first prompt is never flagged — a cold start is unavoidable, not
  a rewarm. Costs are reconstructed from the persisted transcript (per-message usage and billed cost), so they
  survive `/reload` and remain correct across mid-session model switches.
- Exports: Markdown, CSV, and JSON history files now include per-turn rewarm fields (tokens, cost, metered flag);
  Markdown and JSON also record the session rewarm total.

## [0.2.0] - 2026-09-16

### Added

- **Author attribution**: `package.json` now declares `"author": "Jon Leemon"`.
- **Estimated cache-miss cost**: once the footer's cache-TTL countdown expires, it appends a labeled
  estimate of the cost to rebuild the cache (for example `~$0.08 to rebuild`), computed from the last
  response's actual cache token usage and the model's per-million-token cost rates. Uses the model's
  cache-write rate when the provider charges one (Anthropic-style explicit caching), falling back to
  the plain input rate when it doesn't (OpenAI/Gemini-style implicit caching). Shows nothing — not a
  misleading `$0.00` — when there were no cached tokens or the model reports no pricing. Restored from
  the transcript on `/reload`.
- History overlay: a caption line on the **History** tab now states the waiting (30s) and cache-TTL
  (5 min) thresholds so the color coding is self-explanatory.
- Write-to-file: a new **Format** row cycles Markdown / CSV / JSON with `enter`; the auto-path preview
  updates its extension live. CSV rows are comma/quote/newline-escaped; JSON is parseable structured
  output.

### Changed

- Footer/title: once the cache TTL has expired, the countdown switches from a raw, ever-growing
  second-precision stopwatch to a coarse "idle for" duration (seconds, then minutes, then hours+minutes).
- History overlay: "waiting" rows now escalate through the same dim → amber → red bands as the footer
  (amber past 4 minutes, red past the 5-minute cache TTL) instead of being binary dim/red.
- History overlay: the empty state now hints to send a prompt to start tracking, instead of a bare
  `(no history yet)`.
- Title-bar mirror: if you open the `/timer` overlay itself while the agent is still actively working
  underneath it, the title now shows the "still working" elapsed time instead of a possibly-stale idle
  cache countdown, since the agent has not actually gone idle in that case.
- Tab-strip hint text on the write-to-file tab now differs by selected row ("cycle format" vs "save")
  instead of one static line.

## [0.1.0] - 2026-09-10

### Added

- Initial release.
- **Footer timer** (always visible, ticks every second): shows elapsed thinking time while the agent
  works, then a prompt-cache-TTL countdown while idle — dim below 4 minutes, amber at 4, red at 5 —
  with the last run's duration. The idle clock is anchored to the last completed provider response,
  so it counts correctly during idle time, long tool runs, and blocking-prompt waits alike.
- **`/timer` command and `ctrl+alt+t` shortcut**: open a history overlay listing each turn's response
  time and prompt preview, with idle gaps over 30 seconds shown as "waiting" rows (red past the cache
  TTL) and a live row for any in-progress turn.
- **Write to file**: from the overlay, `→` / `w` opens a titled panel offering an auto path
  (`.scratch/timer-<date>[-session].md`, cwd-relative) or a custom location, writing timestamps,
  durations, and prompt previews to Markdown.
- **Title-bar mirror**: while a blocking prompt/overlay covers the footer (for example an
  `ask_user_question` questionnaire), the cache-TTL countdown is mirrored into the terminal title bar.
  Gated by `MIRROR_TO_TITLE_DURING_PROMPTS`.
- History is reconstructed from the in-memory session transcript on demand, so it survives `/reload`
  with no parallel log and no per-turn disk writes; only `/new` starts empty.
