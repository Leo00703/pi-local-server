import type { LiveOrigin } from "./discovery.js";
import type { ContextSource, DiscoveredModel, LocalServerConfig, ServerType } from "./config.js";

async function fetchJsonTimeout(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
  init?: RequestInit,
): Promise<unknown | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onOuter = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      return null;
    }
    signal.addEventListener("abort", onOuter, { once: true });
  }
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, headers: { accept: "application/json", ...(init?.headers ?? {}) } });
    if (!res.ok) return null;
    try {
      return (await res.json()) as unknown;
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuter);
  }
}

interface OpenAIModelEntry {
  id?: string;
  name?: string;
  max_model_len?: number;
  maxModelLen?: number;
  context_length?: number;
  contextLength?: number;
  context_window?: number;
  owned_by?: string;
}

function parseOpenAIModels(data: unknown): OpenAIModelEntry[] {
  if (!data || typeof data !== "object") return [];
  const d = data as { data?: unknown };
  if (!Array.isArray(d.data)) return [];
  return d.data.filter((m): m is OpenAIModelEntry => !!m && typeof m === "object");
}

function modelContextFromEntry(entry: OpenAIModelEntry): number | null {
  for (const v of [
    entry.max_model_len,
    entry.maxModelLen,
    entry.context_length,
    entry.contextLength,
    entry.context_window,
  ]) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
  }
  return null;
}

export function fingerprint(live: LiveOrigin): { type: ServerType; label: string } {
  // Engine-specific payloads (validated by the probes) beat any port guess.
  if (live.lmStudioModels) return { type: "lmstudio", label: "LM Studio" };
  if (live.llamaProps) {
    const build = isRecord(live.llamaProps) ? String(live.llamaProps.build_info ?? "") : "";
    if (/^strata\b/i.test(build)) return { type: "strata", label: "Strata" };
    return { type: "llamacpp", label: "llama.cpp" };
  }
  if (live.ollamaTags) return { type: "ollama", label: "Ollama" };

  const entries = live.v1Models ? parseOpenAIModels(live.v1Models) : [];
  const first = entries[0];
  const ownedBy = String(first?.owned_by ?? "").toLowerCase();

  if (ownedBy.includes("sglang")) return { type: "sglang", label: "SGLang" };
  if (ownedBy.includes("llama-swap") || ownedBy.includes("llamaswap")) {
    return { type: "llamaswap", label: "llama-swap" };
  }
  if (ownedBy.includes("tgi") || ownedBy.includes("huggingface")) {
    return { type: "tgi", label: "HuggingFace TGI" };
  }
  if (ownedBy.includes("tabby")) return { type: "tabby", label: "TabbyAPI" };
  if (ownedBy.includes("aphrodite")) return { type: "aphrodite", label: "Aphrodite" };
  if (first && (typeof first.max_model_len === "number" || typeof first.maxModelLen === "number")) {
    if (live.port === 30000 || live.port === 30010) return { type: "sglang", label: "SGLang" };
    return { type: "vllm", label: "vLLM" };
  }

  switch (live.port) {
    case 11434:
      return { type: "ollama", label: "Ollama" };
    case 1234:
      return { type: "lmstudio", label: "LM Studio" };
    case 1337:
      return { type: "jan", label: "Jan" };
    case 8080:
      return { type: "llamacpp", label: "llama.cpp" };
    case 8095:
      return { type: "strata", label: "Strata" };
    case 8000:
      return { type: "vllm", label: "vLLM" };
    case 30000:
    case 30010:
      return { type: "sglang", label: "SGLang" };
    case 5001:
      return { type: "koboldcpp", label: "KoboldCpp" };
    case 5000:
      return { type: "textgen", label: "text-generation-webui" };
    case 9997:
      return { type: "xinference", label: "Xinference" };
    case 4000:
      return { type: "litellm", label: "LiteLLM proxy" };
    case 48950:
      return { type: "gpt4all", label: "GPT4All" };
    case 2242:
      return { type: "aphrodite", label: "Aphrodite" };
    default:
      return { type: "generic", label: "OpenAI-compatible" };
  }
}

function reasoningHeuristic(id: string): boolean {
  // Tight on purpose: bare `qwen3` / `deepseek` / `r1` substrings false-positive
  // (e.g. `server1`, non-thinking Qwen3-Instruct). Only flag explicit markers.
  if (/no-?reason/i.test(id)) return false;
  return /r1-distill|deepseek-?r1|\br1\b|reasoning|reasoner|thinker|thinking|qwq|gpt-oss|magistral/i.test(id);
}

function resolveContext(
  modelId: string,
  serverKey: string,
  probed: number | null,
  source: ContextSource,
  config: LocalServerConfig,
): { contextWindow: number; contextSource: ContextSource } {
  const override =
    config.contextOverrides[`${serverKey}/${modelId}`] ?? config.contextOverrides[modelId];
  if (typeof override === "number" && override > 0) {
    return { contextWindow: Math.floor(override), contextSource: "server" };
  }
  if (probed && probed > 0) return { contextWindow: probed, contextSource: source };
  return { contextWindow: config.defaultContextWindow, contextSource: "estimated" };
}

/**
 * Output-token budget for a model: half the context window (so the prompt always
 * keeps room and Pi's compaction reserve stays sane), capped at
 * `PI_LOCAL_SERVER_DEFAULT_MAX_TOKENS`. Always strictly below the context window.
 */
export function maxTokensFor(ctx: number, config: LocalServerConfig): number {
  const cap = Number.isFinite(config.defaultMaxTokens) && config.defaultMaxTokens > 0
    ? Math.floor(config.defaultMaxTokens)
    : 32768;
  return Math.max(1, Math.min(cap, Math.floor(ctx / 2)));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function positiveInt(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

// --- llama.cpp -------------------------------------------------------------
//
// Two server shapes exist and report context very differently:
//
//  * single-model:  `/props` -> default_generation_settings.n_ctx is the real
//                   per-slot context the server runs with.
//  * router mode (new llama-server / Llama-macOS app): `/props` reports
//                   `role: "router"` with n_ctx 0, and each `/v1/models` entry
//                   carries `context_length` = the model's *training* context
//                   (e.g. 128000) while the context it will actually be launched
//                   with lives in `status.args` (`--ctx-size 4096`) / `status.preset`.
//                   Trusting `context_length` makes the agent believe in a window
//                   32x larger than the server really has.

export interface LlamaLaunchSettings {
  ctxSize: number | null;
  parallel: number | null;
  kvUnified: boolean;
}

const CTX_FLAGS = ["--ctx-size", "--ctx_size", "-c"];
const PARALLEL_FLAGS = ["--parallel", "--n-parallel", "-np"];

function argValue(tokens: string[], names: string[]): string | null {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    for (const name of names) {
      if (t === name) return tokens[i + 1] ?? null;
      if (t.startsWith(`${name}=`)) return t.slice(name.length + 1);
    }
  }
  return null;
}

function presetValues(preset: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof preset !== "string") return out;
  for (const line of preset.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out.set(m[1]!.replace(/^-+/, "").toLowerCase(), m[2]!);
  }
  return out;
}

/** Extract ctx-size / parallel slots / unified-KV from llama-server launch args and/or a preset block. */
export function parseLlamaLaunchSettings(args: unknown, preset: unknown): LlamaLaunchSettings {
  const tokens = Array.isArray(args) ? args.filter((a): a is string => typeof a === "string") : [];
  const p = presetValues(preset);

  const ctxSize =
    positiveInt(argValue(tokens, CTX_FLAGS)) ??
    positiveInt(p.get("ctx-size") ?? p.get("ctx_size") ?? p.get("c"));
  const parallel =
    positiveInt(argValue(tokens, PARALLEL_FLAGS)) ??
    positiveInt(p.get("parallel") ?? p.get("n-parallel") ?? p.get("np"));

  let kvUnified = false;
  if (tokens.includes("--kv-unified") || tokens.includes("-kvu")) kvUnified = true;
  else if (tokens.includes("--no-kv-unified")) kvUnified = false;
  else {
    const v = (p.get("kv-unified") ?? p.get("kvu") ?? "").toLowerCase();
    kvUnified = v === "1" || v === "true" || v === "on";
  }
  return { ctxSize, parallel, kvUnified };
}

/**
 * Context a single request can use. With N explicit slots and a split KV cache
 * every slot only gets ctx/N; with a unified KV cache one request can use all of it.
 * `--ctx-size 0` means "take it from the model", which we can't know here.
 */
export function effectiveLlamaContext(s: LlamaLaunchSettings): number | null {
  if (!s.ctxSize) return null;
  if (s.parallel && s.parallel > 1 && !s.kvUnified) return Math.floor(s.ctxSize / s.parallel);
  return s.ctxSize;
}

function nCtxFromProps(props: unknown): number | null {
  if (!isRecord(props)) return null;
  const dgs = isRecord(props.default_generation_settings) ? props.default_generation_settings : {};
  return positiveInt(dgs.n_ctx) ?? positiveInt(props.n_ctx);
}

interface LlamaModelEntry extends OpenAIModelEntry {
  status?: { value?: unknown; args?: unknown; preset?: unknown };
  architecture?: { input_modalities?: unknown };
  /** Present for loaded models: `n_ctx` is the running context, `n_ctx_train` the training one. */
  meta?: { n_ctx?: unknown; n_ctx_train?: unknown };
}

/** llama.cpp / Strata expose the chat template; `enable_thinking` in it marks a thinking-capable model. */
function templateThinks(props: unknown): boolean {
  return isRecord(props) && typeof props.chat_template === "string" && props.chat_template.includes("enable_thinking");
}

function acceptsImages(modalities: unknown): boolean {
  return Array.isArray(modalities) && modalities.includes("image");
}

async function llamaCppModels(
  live: LiveOrigin,
  serverKey: string,
  config: LocalServerConfig,
  signal?: AbortSignal,
): Promise<DiscoveredModel[]> {
  const origin = live.origin;
  const entries = parseOpenAIModels(live.v1Models) as LlamaModelEntry[];
  const props = live.llamaProps ?? (await fetchJsonTimeout(`${origin}/props`, config.detailTimeoutMs, signal));
  const propsRec = isRecord(props) ? props : {};
  const isRouter = propsRec.role === "router";
  // In router mode /props describes the router itself (n_ctx 0), not any model.
  const slotCtx = isRouter ? null : nCtxFromProps(props);
  const propsVision = !isRouter && isRecord(propsRec.modalities) && propsRec.modalities.vision === true;

  const named = entries.filter((e): e is LlamaModelEntry & { id: string } => !!e.id);
  if (named.length === 0) {
    // /v1/models can be unreadable (an API key is required): /props still names the model.
    const alias = typeof propsRec.model_alias === "string" && propsRec.model_alias ? propsRec.model_alias : "model";
    const { contextWindow, contextSource } = resolveContext(
      alias,
      serverKey,
      slotCtx,
      "server",
      config,
    );
    return [{
      id: alias,
      contextWindow,
      contextSource,
      maxTokens: maxTokensFor(contextWindow, config),
      reasoning: templateThinks(propsRec) || reasoningHeuristic(alias),
      vision: propsVision,
    }];
  }

  return Promise.all(named.map(async (e) => {
    let probed: number | null = null;
    let thinks = !isRouter && templateThinks(propsRec);
    let source: ContextSource = "server";

    // 1. Router mode, model currently loaded: its own /props is the ground truth.
    //    (Never ask for an unloaded model: that would make the router load it.)
    if (isRouter && e.status?.value === "loaded") {
      const loaded = await fetchJsonTimeout(
        `${origin}/props?model=${encodeURIComponent(e.id)}`,
        config.detailTimeoutMs,
        signal,
      );
      probed = nCtxFromProps(loaded);
      thinks = templateThinks(loaded);
    }
    // 2. Single-model server: /props n_ctx.
    if (!probed && slotCtx) probed = slotCtx;
    //    Running context advertised on the model entry itself (loaded models).
    if (!probed) probed = positiveInt(e.meta?.n_ctx);
    // 3. Router mode, not loaded yet: the ctx it will be launched with.
    if (!probed) {
      probed = effectiveLlamaContext(parseLlamaLaunchSettings(e.status?.args, e.status?.preset));
      if (probed) source = "launch-args";
    }
    // 4. Last resort: the model's training context. An upper bound, not a promise.
    if (!probed) {
      probed = modelContextFromEntry(e) ?? positiveInt(e.meta?.n_ctx_train);
      source = "model-max";
    }

    const { contextWindow, contextSource } = resolveContext(e.id, serverKey, probed, source, config);
    return {
      id: e.id,
      contextWindow,
      contextSource,
      maxTokens: maxTokensFor(contextWindow, config),
      reasoning: thinks || reasoningHeuristic(e.id),
      vision: acceptsImages(e.architecture?.input_modalities) || propsVision,
    };
  }));
}

// --- Ollama: /api/tags + POST /api/show ---
interface OllamaTags {
  models?: Array<{ name?: string; model?: string; details?: { context_length?: unknown } }>;
}

async function ollamaModels(
  origin: string,
  live: LiveOrigin,
  serverKey: string,
  config: LocalServerConfig,
  signal?: AbortSignal,
): Promise<DiscoveredModel[]> {
  let tags: OllamaTags | null = null;
  if (live.ollamaTags && typeof live.ollamaTags === "object") {
    tags = live.ollamaTags as OllamaTags;
  } else {
    tags = (await fetchJsonTimeout(`${origin}/api/tags`, config.detailTimeoutMs, signal)) as OllamaTags | null;
  }
  const names = (tags?.models ?? [])
    .map((m) => m.name ?? m.model ?? "")
    .filter(Boolean);
  // Also merge OpenAI /v1/models ids (Ollama exposes both).
  for (const e of parseOpenAIModels(live.v1Models)) {
    if (e.id && !names.includes(e.id)) names.push(e.id);
  }
  const unique = [...new Set(names)];
  if (unique.length === 0) return [];

  const out: DiscoveredModel[] = [];
  for (const name of unique) {
    let probed: number | null = null;
    const show = (await fetchJsonTimeout(`${origin}/api/show`, config.detailTimeoutMs, signal, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: name }),
    })) as {
      details?: { context_length?: unknown };
      model_info?: Record<string, unknown>;
    } | null;
    if (show) {
      if (typeof show.details?.context_length === "number" && show.details.context_length > 0) {
        probed = Math.floor(show.details.context_length);
      } else if (show.model_info) {
        for (const [k, v] of Object.entries(show.model_info)) {
          if (k.endsWith(".context_length") && typeof v === "number" && v > 0) {
            probed = Math.floor(v);
            break;
          }
        }
      }
    }
    const { contextWindow, contextSource } = resolveContext(
      name,
      serverKey,
      probed,
      "native-api",
      config,
    );
    out.push({
      id: name,
      contextWindow,
      contextSource,
      maxTokens: maxTokensFor(contextWindow, config),
      reasoning: reasoningHeuristic(name),
    });
  }
  return out;
}

// --- LM Studio: native GET /api/v0/models -------------------------------------
//
// `/v1/models` carries no context at all. The native list has, per model:
//   state: "loaded" | "not-loaded", loaded_context_length (what it was loaded with),
//   max_context_length (training max), type: "llm" | "vlm" | "embeddings".
// A loaded model's context changes whenever the user reloads it, so this is re-read on
// every refresh. A model that is not loaded gets JIT-loaded with LM Studio's own default,
// which the API does not reveal: we use PI_LOCAL_SERVER_DEFAULT_CTX (capped at the model max)
// and say so, rather than claiming the (often 1M) training maximum.
interface LmStudioNativeModel {
  id?: string;
  type?: string;
  state?: string;
  max_context_length?: number;
  loaded_context_length?: number;
}

async function lmStudioModels(
  live: LiveOrigin,
  serverKey: string,
  config: LocalServerConfig,
  signal?: AbortSignal,
): Promise<DiscoveredModel[]> {
  const entries = parseOpenAIModels(live.v1Models);
  const native = new Map<string, LmStudioNativeModel>();
  const nativeData =
    live.lmStudioModels ?? (await fetchJsonTimeout(`${live.origin}/api/v0/models`, config.detailTimeoutMs, signal));
  if (isRecord(nativeData) && Array.isArray(nativeData.data)) {
    for (const m of nativeData.data as LmStudioNativeModel[]) if (m?.id) native.set(m.id, m);
  }
  // Prefer the OpenAI list (it is what inference accepts); fall back to the native one.
  const ids = entries.length > 0
    ? entries.map((e) => e.id).filter((id): id is string => !!id)
    : [...native.keys()];

  const out: DiscoveredModel[] = [];
  for (const id of ids) {
    const n = native.get(id);
    if (n?.type === "embeddings") continue; // not a chat model
    let probed: number | null = null;
    let source: ContextSource = "native-api";
    const loadedCtx = positiveInt(n?.loaded_context_length);
    if (n?.state === "loaded" && loadedCtx) {
      probed = loadedCtx;
    } else if (n) {
      const max = positiveInt(n.max_context_length);
      probed = max ? Math.min(config.defaultContextWindow, max) : null;
      source = "estimated";
    }
    const { contextWindow, contextSource } = resolveContext(id, serverKey, probed, source, config);
    out.push({
      id,
      contextWindow,
      contextSource,
      maxTokens: maxTokensFor(contextWindow, config),
      reasoning: reasoningHeuristic(id),
      vision: n?.type === "vlm",
    });
  }
  return out;
}

export async function discoverModels(
  live: LiveOrigin,
  type: ServerType,
  serverKey: string,
  config: LocalServerConfig,
  signal?: AbortSignal,
): Promise<DiscoveredModel[]> {
  const origin = live.origin;

  if (type === "ollama") {
    return ollamaModels(origin, live, serverKey, config, signal);
  }

  if (type === "llamacpp" || type === "llamafile" || type === "strata") {
    return llamaCppModels(live, serverKey, config, signal);
  }

  if (type === "lmstudio" || type === "unsloth" || type === "atomic") {
    return lmStudioModels(live, serverKey, config, signal);
  }

  // llama-swap / vLLM / SGLang / Jan / LM Studio / generic: start from /v1/models.
  const entries = parseOpenAIModels(live.v1Models);
  if (entries.length === 0) return [];
  const out: DiscoveredModel[] = [];
  for (const e of entries) {
    if (!e.id) continue;
    const probed = modelContextFromEntry(e);
    const { contextWindow, contextSource } = resolveContext(e.id, serverKey, probed, "server", config);
    out.push({
      id: e.id,
      name: e.name,
      contextWindow,
      contextSource,
      maxTokens: maxTokensFor(contextWindow, config),
      reasoning: reasoningHeuristic(e.id),
    });
  }
  return out;
}
