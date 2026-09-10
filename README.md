# pi-usage

```
zai(lite) ████████▀▀ 6.8d
```

Usage bars for providers that offer a coding plan.

Shows the active model's quota as a bar with reset-countdown.

## Providers

| Provider     | Model match    | Windows                                                    |
| ------------ | -------------- | ---------------------------------------------------------- |
| OpenAI Codex | `openai-codex` | 5h (primary) + weekly (secondary); separate `spark` bucket |
| OpenCode Go  | `opencode-go`  | 5h rolling (primary) + weekly (secondary); monthly in `/usage` |
| Z.ai         | `zai`          | 5h credits (primary) + weekly credits (secondary)          |

OpenCode Go's plan meters three nested dollar budgets (5h rolling, weekly,
monthly). The statusline renders the first two as a dual bar and `/usage`
reports all three, including the monthly window.

When OpenAI exposes only one Codex window (for example, a Pro account with
weekly-only limits), pi-usage renders a single-row Braille bar and labels the
window `weekly` instead of assuming that `primary` means 5h.

## Install

```bash
pi install git:github.com/thaske/pi-usage
```

## Commands

- `/usage` — query the active provider on demand and show every window with absolute reset times.

## Development

```bash
bun install
bun run check      # typecheck + tests
bun run pi:load-check
```

## License

MIT
