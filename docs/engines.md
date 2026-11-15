# Engines

How each engine is recognised, where its context window comes from, and what to do so other devices can reach it.

## Detection

Every probe checks the *shape* of the answer, not just "HTTP 200 and some JSON". LM Studio, for example, answers unknown paths with `200 {"error": ...}`, which once made it look like Ollama.

1. `GET /v1/models` (OpenAI-compatible, with `Authorization: Bearer <key>`; a dummy `local` key is sent so Jan-style auth does not hide a live server).
2. On live origins: `GET /props` (llama.cpp) and `GET /api/v0/models` (LM Studio) to identify the engine.
3. `GET /api/tags` (Ollama, on every port, so Ollama on a custom port is found).
4. `GET /props` fallback (llama.cpp single-model with an empty `/v1/models`).

The fingerprint then decides: LM Studio native list, `/props`, Ollama `/api/tags` with a `models` array, else `owned_by` (`sglang`, `llama-swap`, `tgi`, `tabby`, `aphrodite`), `max_model_len` (vLLM / SGLang), else the port. Shared ports such as `8080` are distinguished best-effort; behaviour is the same either way because all of them speak the OpenAI-compatible `/v1`.

## Context windows

| Engine | Source |
|---|---|
| llama.cpp / llamafile, single model | `GET /props` → `default_generation_settings.n_ctx` (the real per-slot context) |
| llama.cpp **router mode** (new `llama-server`, Llama-macOS app) | Loaded model: `GET /props?model=<id>`. Otherwise the `--ctx-size` / preset in the model's `status.args` (split by slots when `-np` > 1 without `--kv-unified`). The `context_length` in `/v1/models` is the *training* context and is only a last resort, marked `model-max`. |
| Strata | Same as single-model llama.cpp: `/props` → `n_ctx`, image input from `/props` modalities, thinking from the chat template. Recognised by `build_info: "Strata …"`. |
| LM Studio | `GET /api/v0/models`: loaded model → `loaded_context_length` (exact, follows reloads). Not loaded → `PI_LOCAL_SERVER_DEFAULT_CTX` capped at the model's maximum, marked `estimated` (LM Studio decides at load time and does not say). Embedding models are skipped, `vlm` models get image input. |
| Ollama | `POST /api/show` → `details.context_length` / `model_info.*.context_length` |
| vLLM / SGLang | `/v1/models` entry `max_model_len` |
| llama-swap | `/v1/models` entry if advertised, else the default |
| Jan, MLX-LM, KoboldCpp, text-generation-webui, Xinference, LiteLLM, GPT4All, TGI, TabbyAPI, Aphrodite, generic | `/v1/models` entry if advertised, else `PI_LOCAL_SERVER_DEFAULT_CTX` (marked `estimated`, overridable) |

Image input is enabled for models the server advertises as vision-capable (llama.cpp `architecture.input_modalities` or `/props` modalities).

## Default ports

llama.cpp `8080`, Strata `8080` / `8095`, LM Studio `1234`, Ollama `11434`, vLLM `8000`, SGLang `30000` / `30010`, Jan `1337`, MLX-LM `8080`, Unsloth Desktop `1234` / `8000`, Atomic Chat `1234` / `8000`, llama-swap `8080`, LocalAI `8080`, llamafile `8080`, KoboldCpp `5001`, text-generation-webui `5000`, Xinference `9997`, LiteLLM proxy `4000`, GPT4All `48950`, HuggingFace TGI `8080`, TabbyAPI `5000`, Aphrodite `2242`.

## Making a server reachable

Discovery only finds what other devices can reach. Most engines listen on `127.0.0.1` unless told otherwise, so the laptop will not see them. Servers on the same machine are always found.

| Engine | What to do |
|---|---|
| llama.cpp | Start `llama-server` with `--host 0.0.0.0` |
| LM Studio | Developer tab → Server settings → enable *Serve on Local Network* |
| Strata | Add `"--host" "0.0.0.0"` to the model's run script (the `serve\server.py` command), or `"host": "0.0.0.0"` in `strata-<model>.json` |
| Ollama | Set `OLLAMA_HOST=0.0.0.0` |

Then allow the port in the host's firewall. For Tailscale only, allow the Tailscale range `100.64.0.0/10` instead of opening the port to every network.

An API key is optional for most engines. If you set one, give it to this tool with `PI_LOCAL_SERVER_API_KEYS="<address>:<port>=<key>"` (see [configuration](configuration.md)).
