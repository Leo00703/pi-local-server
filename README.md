# pi-local-server

Pi extension that auto-discovers local LLM servers on your LAN first, then Tailscale, and registers each as its own Pi provider with dynamic models + context windows.

Solves the new-laptop problem: instead of hand-coding a temporary provider that points at your main PC, install this extension and your local servers show up in `/model` automatically.

## How it works

1. **Startup (fast, blocking):** restores last session from cache (`~/.pi/agent/pi-local-server-cache.json`), then probes `127.0.0.1` + `PI_LOCAL_SERVER_HOSTS` on all known ports.
2. **Background (`session_start`):** full sweep — configured hosts, ARP LAN hosts (all ports), `/24` sweep fallback (common ports), Tailscale peers (always, even if LAN already hit). Each live origin becomes one provider: `local-<type>-<host>-<port>`.
3. **Refresh:** every provider gets `refreshModels()` that re-probes its own `host:port`, so `/model` refresh and reconnects pick up new/removed models without restart.

Probing per origin (`discovery.ts`):

- `GET /v1/models` (OpenAI-compatible, with `Authorization: Bearer <key>`; dummy `local` key sent so Jan-style auth doesn't hide a live server)
- `GET /api/tags` (Ollama, on every port — catches Ollama on custom ports)
- `GET /props` fallback (llama.cpp single-model with empty `/v1/models`)

Fingerprint (`detectors.ts`): `ollamaTags` → Ollama, `llamaProps` → llama.cpp, else `owned_by` (`sglang`, `llama-swap`, `tgi`, `tabby`, `aphrodite`), `max_model_len` → vLLM/SGLang, else port map.

Context windows (never hardcoded):

| Server | Source |
|---|---|
| llama.cpp / llama-swap / llamafile | `GET /props` → `default_generation_settings.n_ctx` (per-model `max_model_len` preferred for llama-swap) |
| Ollama | `POST /api/show` → `details.context_length` / `model_info.*.context_length` |
| vLLM / SGLang | `/v1/models` entry `max_model_len` |
| LM Studio / Unsloth / Atomic | `/v1/models` entry, then native `/api/v0/models`, `/api/v1/models`, `/api/v0/models/loaded` |
| Jan / MLX / KoboldCpp / textgen / Xinference / LiteLLM / GPT4All / TGI / TabbyAPI / Aphrodite / generic | `/v1/models` entry if advertised, else `PI_LOCAL_SERVER_DEFAULT_CTX` (marked `estimated`, overridable) |

`maxTokens` = `min(PI_LOCAL_SERVER_DEFAULT_MAX_TOKENS, max(1024, ctx))`.

## Supported servers

llama.cpp (`8080`), LM Studio (`1234`), Ollama (`11434`), vLLM (`8000`), SGLang (`30000`, `30010`), Jan (`1337`), MLX-LM (`8080`), Unsloth Desktop (`1234`, `8000`), Atomic Chat (`1234`, `8000`), llama-swap (`8080`), LocalAI (`8080`), llamafile (`8080`), KoboldCpp (`5001`), text-generation-webui (`5000`), Xinference (`9997`), LiteLLM proxy (`4000`), GPT4All (`48950`), HuggingFace TGI (`8080`), TabbyAPI (`5000`), Aphrodite (`2242`), generic OpenAI-compatible.

Shared ports (e.g. `8080`) are distinguished best-effort via `owned_by` / native endpoints; functionality is identical either way since all speak OpenAI-compatible `/v1`.

## Commands

- `/local-server` or `/local-server status` — list registered providers, models, which contexts are `estimated`.
- `/local-server rescan` — full LAN + Tailscale sweep now (reports `found N provider(s), M new, K hosts scanned`).
- `/local-server hosts` — show configured hosts; hint to set `PI_LOCAL_SERVER_HOSTS`.

## Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `PI_LOCAL_SERVER_HOSTS` | — | Comma list of extra hosts always probed, e.g. `main-pc,main-pc.tailnet.ts.net,192.168.1.10`. Use for Tailscale names. |
| `PI_LOCAL_SERVER_API_KEY` | `local` | Global key sent as `Bearer` (dummy `local` keeps Jan from 401-hiding). |
| `PI_LOCAL_SERVER_API_KEYS` | — | Per-server map `host:port=key,...`, e.g. `192.168.1.10:8080=sk-...,myhost:1234=key`. Exact `host:port` match wins over global. |
| `PI_LOCAL_SERVER_CTX_OVERRIDES` | — | Per-model map `model=ctx` or `host:port/model=ctx`, e.g. `llama-3.1-8b=131072,192.168.1.10:8080/model=32768`. |
| `PI_LOCAL_SERVER_DEFAULT_CTX` | `32768` | Fallback when server doesn't advertise (flagged `estimated` in status). |
| `PI_LOCAL_SERVER_DEFAULT_MAX_TOKENS` | `4096` | Cap for `maxTokens`. |
| `PI_LOCAL_SERVER_TIMEOUT_MS` | `700` | Per-probe timeout for sweep. |
| `PI_LOCAL_SERVER_DETAIL_TIMEOUT_MS` | `4000` | Timeout for detail calls (`/api/show`, `/props`, native ctx). |
| `PI_LOCAL_SERVER_DISABLE` | — | Comma list of types to skip, e.g. `ollama,jan`. |
| `PI_LOCAL_SERVER_NO_LAN` | — | Set `1` to skip LAN/ARP/sweep. |
| `PI_LOCAL_SERVER_NO_TAILSCALE` | — | Set `1` to skip Tailscale. |

Cache: `~/.pi/agent/pi-local-server-cache.json` (override dir with `PI_CODING_AGENT_DIR`). Delete it for a clean slate.

## Install

Add to your Pi agent package:

```json
{
  "dependencies": {
    "pi-local-server": "file:/path/to/pi-local-server"
  }
}
```

The `pi.extensions` entry (`./extensions/pi-local-server/index.ts`) is already declared in `package.json`.

## Notes / limits

- Origins are always `http://`. Local LAN / Tailscale servers are plain HTTP; HTTPS remotes aren't supported.
- `/24` blind sweep only runs when ARP + configured hosts found nothing, and only on common ports (`8080, 1234, 11434, 8000, 1337, 30000, 4000, 5000, 2242`) to keep rescans ~15–30s. ARP-discovered hosts are always probed on all ports.
- Reasoning flag is heuristic (`r1-distill`, `deepseek-r1`, `reasoning`, `thinking`, `qwq`, `gpt-oss`, `magistral`); `supportsReasoningEffort` stays off since no local server implements OpenAI's `reasoning_effort` param.
- `supportsDeveloperRole` stays off (safe mapping to system/user on local backends).
