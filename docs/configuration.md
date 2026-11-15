# Configuration

Nothing here is required: discovery works without any setting. Use these only to add hosts discovery cannot find, to give a key to a server that enforces one, or to override a number.

## Environment variables (Pi extension)

| Variable | Default | Meaning |
|---|---|---|
| `PI_LOCAL_SERVER_HOSTS` | none | Comma list of extra hosts that are always probed, e.g. `main-pc,main-pc.tailnet.ts.net,192.168.1.10`. Use it for Tailscale names or machines the sweep cannot see. |
| `PI_LOCAL_SERVER_API_KEY` | `local` | Global key. Only sent to loopback and to hosts listed in `PI_LOCAL_SERVER_HOSTS`; every other discovered host gets the dummy `local`. |
| `PI_LOCAL_SERVER_API_KEYS` | none | Per-server keys `host:port=key,...`, e.g. `100.64.0.2:8080=sk-...`. The host must be written as discovery finds it (the Tailscale IP, or the name you put in `PI_LOCAL_SERVER_HOSTS`). Only needed if the server enforces a key. |
| `PI_LOCAL_SERVER_CTX_OVERRIDES` | none | Per-model context `model=ctx` or `host:port/model=ctx`, e.g. `llama-3.1-8b=131072,192.168.1.10:8080/model=32768`. |
| `PI_LOCAL_SERVER_DEFAULT_CTX` | `32768` | Fallback when a server does not advertise a context (the model is marked *estimated*). |
| `PI_LOCAL_SERVER_DEFAULT_MAX_TOKENS` | `32768` | Upper cap for `maxTokens`; the effective value is `min(cap, ctx / 2)`. |
| `PI_LOCAL_SERVER_TIMEOUT_MS` | `700` | Per-probe timeout during sweeps. |
| `PI_LOCAL_SERVER_DETAIL_TIMEOUT_MS` | `4000` | Timeout for detail calls (`/api/show`, `/props`, native APIs). |
| `PI_LOCAL_SERVER_DISABLE` | none | Comma list of engine types to skip, e.g. `ollama,jan`. |
| `PI_LOCAL_SERVER_NO_LAN` | none | Set to `1` to skip LAN / ARP / subnet sweep. |
| `PI_LOCAL_SERVER_NO_TAILSCALE` | none | Set to `1` to skip Tailscale. |

## OpenCode plugin options

The OpenCode plugin takes the same settings as plugin options (`hosts`, `apiKeys`, `contextOverrides`, `disable`, `lan`, `tailscale`). See [opencode/README.md](../opencode/README.md).

## How a context window is chosen

`maxTokens` is `min(PI_LOCAL_SERVER_DEFAULT_MAX_TOKENS, ctx / 2)`, so it is always below the window.

Each model records where its context came from:

| Source | Exact? | Meaning |
|---|---|---|
| `server` | yes | The server reported the context it is running with |
| `native-api` | yes | The engine's own API reported it (e.g. LM Studio's loaded context length) |
| `launch-args` | yes | Read from the model's launch arguments (llama.cpp router mode) |
| `model-max` | no | The model's training maximum; the server may run with less |
| `estimated` | no | Nothing advertised; the default or your override is used |

`/local-server status` shows how many models in each provider are not verified.

## Cache

The Pi extension keeps `~/.pi/agent/pi-local-server-cache.json` (the folder can be changed with `PI_CODING_AGENT_DIR`) so a new session is usable before the network sweep ends.

- It is versioned: a cache written by an older release is ignored.
- Each entry remembers when the server was last really seen. One that was not seen for 7 days is forgotten.
- A machine remembered at two addresses (LAN and Tailscale) is kept once.
- It stores addresses and model metadata, never API keys.

Delete the file for a clean slate.

## Limits

- Origins are always `http://`. Local LAN and Tailscale servers speak plain HTTP; HTTPS remotes are not supported.
- The `/24` blind sweep only runs when the ARP table and the configured hosts found nothing, and only on common ports (`8080, 1234, 11434, 8000, 1337, 30000, 4000, 5000, 2242`), to keep a rescan around 15 to 30 seconds. Hosts found through ARP are probed on all known ports.
- The reasoning flag is heuristic (`r1-distill`, `deepseek-r1`, `reasoning`, `thinking`, `qwq`, `gpt-oss`, `magistral`). `supportsReasoningEffort` stays off because no local server implements OpenAI's `reasoning_effort`, and `supportsDeveloperRole` stays off (it is mapped safely to system / user).
