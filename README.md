# pi-prompt-timer

A [Pi](https://pi.dev/) extension that shows live timing information for every conversation turn.

## What it does

### Thinking timer (widget above editor)

While the agent is working, a prominent timer appears above the input field:

```
  ⏱  1:23  started 14:32:05
```

The widget disappears automatically when the agent settles.

### Idle timer (footer)

After the agent responds, a counter in the footer tracks how long you've been idle. It changes colour as you
approach the Anthropic prompt-cache TTL:

| Elapsed | Colour | Label |
|---------|--------|-------|
| < 4 min | dim    | `⌛ 2:45  @14:33:28   last: 1:23` |
| 4–5 min | warning | `⌛ 4:12  · cache expires in 0:48` |
| ≥ 5 min | error/red | `⌛ 5:03  ⚠ cache expired` |

### Transcript timestamps

A small timestamp marker is appended to the session transcript after each user prompt and each agent
response — TUI-only, never sent to the model.

```
  ↑ 14:32:05
  ↓ 14:33:28  (1:23)
```

## Install

```bash
pi install git:github.com/nomeelnoj/pi-prompt-timer
```

Then reload pi:

```
/reload
```

For a one-off run without installing:

```bash
pi -e git:github.com/nomeelnoj/pi-prompt-timer
```

Or from a local checkout:

```bash
git clone https://github.com/nomeelnoj/pi-prompt-timer.git
cd pi-prompt-timer
npm ci
pi -e "$(pwd)"
```

## Requirements

- Pi 0.84.4 or newer
- Node.js 22 or newer

## Development

```bash
npm ci
npm run typecheck
```

To test interactively:

```bash
pi -e "$(pwd)"
```

## License

MIT
