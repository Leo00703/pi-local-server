import type { LiveOrigin } from "./discovery.js";
import type { DiscoveredModel, LocalServerConfig, ServerType } from "./config.js";

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
  owned_by?: string;
}

function parseOpenAIModels(data: unknown): OpenAIModelEntry[] {
  if (!data || typeof data !== "object") return [];
  const d = data as { data?: unknown };
  if (!Array.isArray(d.data)) return [];
  return d.data.filter((m): m is OpenAIModelEntry => !!m && typeof m === "object");
}

function modelContextFromEntry(entry: OpenAIModelEntry): number | null {
  for (const v of [entry.max_model_len, entry.maxModelLen, entry.context_length, entry.contextLength]) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
  }
  return null;
}

export function fingerprint(live: LiveOrigin): { type: ServerType; label: string } {
  if (live.ollamaTags) return { type: "ollama", label: "Ollama" };
  if (live.llamaProps) return { type: "llamacpp", label: "llama.cpp" };

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
  source: DiscoveredModel["contextSource"],
  config: LocalServerConfig,
): { contextWindow: number; contextSource: DiscoveredModel["contextSource"] } {
  const override =
    config.contextOverrides[`${serverKey}/${modelId}`] ?? config.contextOverrides[modelId];
  if (typeof override === "number" && override > 0) {
    return { contextWindow: Math.floor(override), contextSource: "server" };
  }
  if (probed && probed > 0) return { contextWindow: probed, contextSource: source };
  return { contextWindow: config.defaultContextWindow, contextSource: "estimated" };
}

function maxTokensFor(ctx: number, config: LocalServerConfig): number {
  return Math.min(config.defaultMaxTokens, Math.max(1024, ctx));
}

// --- llama.cpp: /props -> default_generation_settings.n_ctx ---
async function llamaContext(origin: string, timeoutMs: number, signal?: AbortSignal): Promise<number | null> {
  const data = await fetchJsonTimeout(`${origin}/props`, timeoutMs, signal);
  if (!data || typeof data !== "object") return null;
  const d = data as { default_generation_settings?: { n_ctx?: unknown }; n_ctx?: unknown };
  const n = d.default_generation_settings?.n_ctx ?? d.n_ctx;
  return typeof n === "number" && n > 0 ? Math.floor(n) : null;
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

// --- LM Studio native: best-effort /api/v0/models + /api/v1/models ---
async function lmStudioNativeContext(
  origin: string,
  modelId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<number | null> {
  for (const path of ["/api/v0/models", "/api/v1/models", "/api/v0/models/loaded"]) {
    const data = await fetchJsonTimeout(`${origin}${path}`, timeoutMs, signal);
    if (!data || typeof data !== "object") continue;
    const arr = Array.isArray((data as { data?: unknown }).data)
      ? ((data as { data: unknown[] }).data as Record<string, unknown>[])
      : Array.isArray(data)
        ? (data as Record<string, unknown>[])
        : [];
    for (const m of arr) {
      const id = String(m["id"] ?? m["model"] ?? "");
      if (id && id !== modelId) continue;
      for (const k of ["context_length", "contextLength", "n_ctx", "max_model_len", "maxModelLen"]) {
        const v = m[k];
        if (typeof v === "number" && v > 0) return Math.floor(v);
      }
    }
  }
  return null;
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

  if (type === "llamacpp" || type === "llamaswap" || type === "llamafile") {
    const entries = parseOpenAIModels(live.v1Models);
    const ids = entries.map((e) => e.id).filter((id): id is string => !!id);
    const ctx = await llamaContext(origin, config.detailTimeoutMs, signal);
    // llama-swap advertises per-model ctx in entries; prefer it when present.
    if (ids.length === 0) {
      const { contextWindow, contextSource } = resolveContext("model", serverKey, ctx, "server", config);
      return [{ id: "model", contextWindow, contextSource, maxTokens: maxTokensFor(contextWindow, config), reasoning: false }];
    }
    return ids.map((id) => {
      const entryCtx = modelContextFromEntry(entries.find((e) => e.id === id) ?? {});
      const { contextWindow, contextSource } = resolveContext(id, serverKey, entryCtx ?? ctx, entryCtx ? "server" : "server", config);
      return {
        id,
        contextWindow,
        contextSource,
        maxTokens: maxTokensFor(contextWindow, config),
        reasoning: reasoningHeuristic(id),
      };
    });
  }

  // vLLM / SGLang / Jan / LM Studio / generic: start from /v1/models.
  const entries = parseOpenAIModels(live.v1Models);
  if (entries.length === 0) return [];
  const out: DiscoveredModel[] = [];
  for (const e of entries) {
    if (!e.id) continue;
    let probed = modelContextFromEntry(e);
    let source: DiscoveredModel["contextSource"] = "server";
    if (!probed && (type === "lmstudio" || type === "unsloth" || type === "atomic")) {
      probed = await lmStudioNativeContext(origin, e.id, config.detailTimeoutMs, signal);
      source = "native-api";
    }
    const { contextWindow, contextSource } = resolveContext(e.id, serverKey, probed, source, config);
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
