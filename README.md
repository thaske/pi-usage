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
| Z.ai         | `zai`          | 5h credits (primary) + weekly credits (secondary)          |

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
