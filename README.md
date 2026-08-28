# pi-usage

Unified statusline usage bars for [pi](https://pi.dev) for providers that offer a coding plan. Shows the active model's quota as a braille bar with reset-countdown annotations.

### OpenAI Codex (5h + weekly)

```
codex ███████▀▀ 5.5d
```

### Z.ai GLM coding plan (5h + weekly credits)

```
zai(lite) ███▙▄▄▄▄▄⠀ 7d
```

## Install

```bash
pi install git:github.com/thaske/pi-usage
```

## Providers

| Provider     | Model match    | Windows                                                    |
| ------------ | -------------- | ---------------------------------------------------------- |
| OpenAI Codex | `openai-codex` | 5h (primary) + weekly (secondary); separate `spark` bucket |
| Z.ai         | `zai`          | 5h credits (primary) + weekly credits (secondary)          |

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
