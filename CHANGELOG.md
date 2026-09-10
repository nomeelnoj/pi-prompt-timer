# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
