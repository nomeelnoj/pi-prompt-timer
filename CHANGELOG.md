# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-09-10

### Added

- Initial release.
- Thinking timer widget above the editor: shows elapsed time while the agent is working, with
  start timestamp. Dismissed automatically on `agent_settled`.
- Idle timer in footer: counts up since the last agent response, dim below 4 minutes, warning
  at 4 minutes, error/red at 5 minutes (Anthropic prompt-cache TTL). Includes remaining-time
  countdown in the warning band and explicit "cache expired" label once TTL passes.
- Transcript timestamps: a small `↑`/`↓` stamp appended after each user prompt and agent
  response, showing wall-clock time and run duration. TUI-only; never enters LLM context.
- Single 1-second tick loop drives all live surfaces; started on `session_start` and stopped
  cleanly on `session_shutdown`.
