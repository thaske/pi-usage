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

## Extension integration

pi-usage owns all provider-specific quota knowledge and exposes it to other extensions over pi's shared `pi.events` bus. Consumers (for example `pi-goal`) never reimplement provider endpoints or auth.

| Channel | Direction | Payload |
| --- | --- | --- |
| `pi-usage:quota:providers` | pi-usage → `*` | `{ providers: string[] }` |
| `pi-usage:quota:providers:request` | consumer → pi-usage | `{}` |
| `pi-usage:quota:request` | consumer → pi-usage | `{ requestId, provider, model?: { provider, id, name? } }` |
| `pi-usage:quota:response` | pi-usage → consumer | `{ requestId, ok: true, provider, label, exhausted }` or `{ requestId, ok: false, provider, error }` |

A request that matches no registered provider, has no active session context, or fails its query is answered with `ok: false`; pi-usage always replies on every path so a consumer never waits for its timeout unnecessarily.

```ts
pi.events.on("pi-usage:quota:providers", (event) => providers = event.providers);
pi.events.emit("pi-usage:quota:providers:request", {});

const requestId = crypto.randomUUID();
pi.events.on("pi-usage:quota:response", (response) => {
  if (response.requestId !== requestId || !response.ok) return;
  if (response.exhausted) pauseWork();
});
pi.events.emit("pi-usage:quota:request", { requestId, provider: "opencode-go" });
```

`exhausted` is true when any window of the active provider bucket (5h, weekly, or OpenCode Go monthly) has consumed 100% of its quota.

## Development

```bash
bun install
bun run check      # typecheck + tests
bun run pi:load-check
```

## License

MIT
