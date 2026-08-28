# pi-usage

Unified statusline usage bars for [pi](https://pi.dev) coding providers.
Shows the active model's quota as a braille bar with reset-countdown
annotations, following the conventions of the Codex usage extensions.

```
codex ▇▇▇▇▇▀▀▀▀▀ 5.5d        <- OpenAI Codex (5h + weekly)
zai(lite) ███▙▄▄▄▄▄⠀ 7d      <- Z.ai GLM coding plan (5h + weekly credits)
spark ▂▂⠀⠀⠀⠀⠀⠀⠀⠀ 3.2h     <- Codex spark bucket
```

## How it reads

- The bar renders the **remaining** share of each quota window.
- Dual-window plans use a 10-cell braille bar: the **upper halves** are the
  short rolling window (5h), the **lower halves** the long window (weekly).
- The dim annotation is the countdown to the long window's reset ("1.5d",
  "3.2h", "42m"). When the 5h window is exhausted, both countdowns show
  ("18m/1.2d") and the bar background turns red.
- Single-window plans degrade to "58% 3.2h" text.
- While querying, an animated braille loading bar plays; the bar blinks
  when values change; the countdown ticks exactly at display boundaries.

## Providers

| Provider | Model match | Query | Windows |
| --- | --- | --- | --- |
| OpenAI Codex | `openai-codex` | pi Codex auth → ChatGPT backend, `codex app-server` fallback (ported from `@llblab/pi-codex-usage`, MIT) | 5h (primary) + weekly (secondary); separate `spark` bucket |
| Z.ai | `zai` | provider API key → `api.z.ai/api/monitor/usage/quota/limit` | 5h credits (primary) + weekly credits (secondary); plan tier shown as `zai(lite)` |

Z.ai migrated coding-plan quotas from `TOKENS_LIMIT` to `CREDIT_LIMIT`
(same unit semantics: unit 3 = 5h, unit 6 = weekly), so both types are
accepted.

## Architecture

```
src/
  types.ts          UsageProvider interface + normalized snapshot/report types
  braille.ts        braille bar rendering (single/dual/loading)
  countdown.ts      reset countdown formatting + tick-aligned delay math
  statusline.ts     themed "label bar annotation" composition
  util.ts           timed fetch, payload coercion, timestamp parsing, redaction
  providers/
    codex.ts        OpenAI Codex adapter
    zai.ts          Z.ai adapter
  index.ts          extension shell: statusline lifecycle, cache, timers, /usage
```

Adding a provider means implementing `UsageProvider` (match a model
provider, query its API, normalize into primary/secondary windows) and
registering it in `PROVIDERS` in `src/index.ts`. Rendering, caching, and
lifecycle are provider-agnostic.

## Commands

- `/usage` — query the active provider on demand and show every window with
  absolute reset times.

## Install

```bash
pi install /absolute/path/to/pi-usage   # local checkout
pi install git:github.com/you/pi-usage  # once published
```

## Development

```bash
bun install
bun run check      # typecheck + tests
bun run pi:load-check
```

## License

MIT
