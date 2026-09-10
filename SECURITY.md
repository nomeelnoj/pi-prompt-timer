# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities through this repository's private
[GitHub Security Advisory form](https://github.com/nomeelnoj/pi-prompt-timer/security/advisories/new). Do not include
sensitive details in a public issue.

Include the affected package and Pi versions, operating system, terminal, steps to reproduce, impact, and any proposed
mitigation. Maintainers will use the advisory thread for follow-up and coordination.

## Security boundary

`@nomeelnoj/pi-prompt-timer` reads timing and message metadata already present in the local Pi session (the in-memory
session transcript) to reconstruct how long each turn took. It does not read session files from disk, and it does not
send anything to the model or to any network service.

The extension surfaces information in three local places:

- The Pi footer, which shows the live timer and prompt-cache-TTL countdown.
- The terminal title bar, which mirrors the cache-TTL countdown while a blocking prompt or overlay covers the footer.
- A Markdown history file, written only on an explicit "Write to file" action to a path you confirm (default
  `.scratch/timer-<date>[-session].md`, relative to the current working directory).

The written history file contains per-turn timestamps, durations, and short prompt previews (the first line of each
prompt, truncated). If you write it to a shared or committed location, be aware it can contain those prompt snippets.
The extension creates the target directory if needed and never deletes or overwrites files it was not explicitly asked
to write.

The package has no runtime dependencies and no install scripts.
