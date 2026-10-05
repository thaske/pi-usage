# pi-usage

```
zai(lite) ████████▀▀ 6.8d
```

Usage bars for providers that offer a coding plan.

Shows provider/account quota as a bar with reset-countdown. For native OpenAI
models, the bar is the Codex CLI account's quota, not a verified model-specific
inference limit.

## Providers

| Provider     | Model match    | Windows                                                    |
| ------------ | -------------- | ---------------------------------------------------------- |
| OpenAI Codex | `openai-codex`; native `openai` with ChatGPT OAuth | 5h (primary) + weekly (secondary); separate `spark` bucket |
| OpenCode Go  | `opencode-go`  | 5h rolling (primary) + weekly (secondary); monthly in `/usage` |
| Z.ai         | `zai`          | 5h credits (primary) + weekly credits (secondary)          |

OpenCode Go's plan meters three nested dollar budgets (5h rolling, weekly,
monthly). The statusline renders the first two as a dual bar and `/usage`
reports all three, including the monthly window.

ChatGPT.app's usage UI reads its private `/wham/usage` endpoint (and
`/wham/usage/stream`). In local testing, Pi's native OpenAI OAuth token was
not accepted by that endpoint (HTTP 401). For native `openai` models,
pi-usage instead queries `account/rateLimits/read` through the local
`codex app-server`, which uses the separately authenticated Codex CLI account.
This requires Pi's `openai` provider to be signed in with ChatGPT OAuth; API-key
auth is excluded. Install the Codex CLI, make sure `codex` is on PATH, and sign
it into the intended account. Pi-usage cannot correlate the two logins.
Even when the accounts match, we have not verified that the returned Codex
bucket governs native OpenAI inference, including `gpt-6-luna`. `/usage`
includes this attribution warning; a successful query only confirms that the
CLI returned account quota, not that it is the active model's limit.

The legacy `openai-codex` provider prefers Pi's Codex auth for ordinary models
and the app-server for Spark, falling back to the other source if needed.
Cache and in-flight query sharing are isolated by model provider and quota
bucket so legacy and native authentication paths do not reuse each other's
reports. This does not detect account changes within the same auth source.

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

The announced ids are model-provider ids: `openai-codex`, `openai`,
`opencode-go`, and `zai`. Native `openai` requests route to the Codex adapter
but are eligible only with Pi's ChatGPT OAuth sign-in. Announcement indicates
adapter support, not that the provider is currently authenticated.

When supplied, `model.provider` must match `provider`. Without a model, the
active model is used if its provider matches; otherwise the requested
provider's default bucket is queried. A valid request that matches no eligible
provider, has no active session context, or fails its query is answered with
`ok: false`. Malformed requests are ignored.

For native `openai`, `exhausted` describes the Codex CLI account's bucket.
Consumers must not treat it as verified exhaustion of the active model's
inference quota.

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
