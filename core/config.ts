import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";

export type ServerType =
  | "llamacpp"
  | "strata"
  | "lmstudio"
  | "ollama"
  | "vllm"
  | "sglang"
  | "jan"
  | "mlx"
  | "unsloth"
  | "atomic"
  | "llamaswap"
  | "localai"
  | "koboldcpp"
  | "textgen"
  | "xinference"
  | "litellm"
  | "gpt4all"
  | "llamafile"
  | "tgi"
  | "tabby"
  | "aphrodite"
  | "generic";

export interface ServerDef {
  type: ServerType;
  label: string;
  ports: number[];
  /** Hint for detection priority. Lower = checked first. */
  priority: number;
}

export const SERVER_DEFS: ServerDef[] = [
  { type: "llamacpp", label: "llama.cpp", ports: [8080], priority: 1 },
  { type: "lmstudio", label: "LM Studio", ports: [1234], priority: 2 },
  { type: "ollama", label: "Ollama", ports: [11434], priority: 3 },
  { type: "vllm", label: "vLLM", ports: [8000], priority: 4 },
  { type: "sglang", label: "SGLang", ports: [30000, 30010], priority: 5 },
  { type: "jan", label: "Jan", ports: [1337], priority: 6 },
  // Strata speaks llama.cpp's dialect (/props, /v1/models meta.n_ctx); 8095 is its own default port.
  { type: "strata", label: "Strata", ports: [8080, 8095], priority: 7 },
  // Extras / generic OpenAI-compatible (checked after the big ones)
  { type: "llamaswap", label: "llama-swap", ports: [8080], priority: 20 },
  { type: "localai", label: "LocalAI", ports: [8080], priority: 21 },
  { type: "llamafile", label: "llamafile", ports: [8080], priority: 22 },
  { type: "mlx", label: "MLX-LM server", ports: [8080], priority: 23 },
  { type: "unsloth", label: "Unsloth Desktop", ports: [1234, 8000], priority: 24 },
  { type: "atomic", label: "Atomic Chat", ports: [1234, 8000], priority: 25 },
  { type: "koboldcpp", label: "KoboldCpp", ports: [5001], priority: 26 },
  { type: "textgen", label: "text-generation-webui", ports: [5000], priority: 27 },
  { type: "xinference", label: "Xinference", ports: [9997], priority: 28 },
  { type: "litellm", label: "LiteLLM proxy", ports: [4000], priority: 29 },
  { type: "gpt4all", label: "GPT4All", ports: [48950], priority: 30 },
  { type: "tgi", label: "HuggingFace TGI", ports: [8080], priority: 31 },
  { type: "tabby", label: "TabbyAPI", ports: [5000], priority: 32 },
  { type: "aphrodite", label: "Aphrodite", ports: [2242], priority: 33 },
  { type: "generic", label: "OpenAI-compatible", ports: [8080, 8000, 1234, 11434], priority: 100 },
];

export interface DiscoveredServer {
  type: ServerType;
  label: string;
  host: string;
  port: number;
  origin: string; // e.g. http://192.168.1.10:8080
  baseUrl: string; // e.g. http://192.168.1.10:8080/v1
  latencyMs: number;
  source: "localhost" | "lan" | "tailscale" | "config" | "cache";
  /** Human-readable peer name (e.g. Tailscale hostname) shown in the provider name. */
  hostName?: string;
}

/**
 * Where a model's context window came from.
 * - `server`:      the running server reported it (e.g. llama.cpp `/props` n_ctx) — exact.
 * - `native-api`:  a vendor API reported it (Ollama `/api/show`, LM Studio) — exact.
 * - `launch-args`: parsed from the server's launch arguments (`--ctx-size`) — exact.
 * - `model-max`:   the model's training/maximum context; the server may run with less.
 * - `estimated`:   nothing advertised; `PI_LOCAL_SERVER_DEFAULT_CTX` fallback.
 */
export type ContextSource = "server" | "native-api" | "launch-args" | "model-max" | "estimated";

/** True when the context window is what the server will really use. */
export function isExactContext(source: ContextSource): boolean {
  return source === "server" || source === "native-api" || source === "launch-args";
}

export interface DiscoveredModel {
  id: string;
  name?: string;
  contextWindow: number;
  contextSource: ContextSource;
  maxTokens: number;
  reasoning: boolean;
  /** Model accepts image input (advertised by the server). */
  vision?: boolean;
}

export interface LocalServerConfig {
  timeoutMs: number;
  detailTimeoutMs: number;
  extraHosts: string[];
  disabledTypes: ServerType[];
  defaultContextWindow: number;
  defaultMaxTokens: number;
  apiKey: string;
  perServerApiKeys: Record<string, string>;
  contextOverrides: Record<string, number>;
  enableLanScan: boolean;
  enableTailscale: boolean;
}

function parseListEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Parse `k=v,k2=v2` env maps. Keys are trimmed, values keep `=` after the first. */
function parseMapEnv(value: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value) return out;
  for (const part of value.split(",")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

function parseContextOverridesEnv(value: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(parseMapEnv(value))) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) out[k] = Math.floor(n);
  }
  return out;
}

/** Settings an adapter can pass explicitly (e.g. OpenCode plugin options) on top of the environment. */
export interface ConfigOverrides {
  hosts?: string[];
  apiKey?: string;
  apiKeys?: Record<string, string>;
  contextOverrides?: Record<string, number>;
  disable?: string[];
  defaultContextWindow?: number;
  defaultMaxTokens?: number;
  lan?: boolean;
  tailscale?: boolean;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: ConfigOverrides = {},
): LocalServerConfig {
  const base = loadEnvConfig(env);
  return {
    ...base,
    extraHosts: [...new Set([...base.extraHosts, ...(overrides.hosts ?? [])])],
    disabledTypes: [...base.disabledTypes, ...((overrides.disable ?? []) as ServerType[])],
    apiKey: overrides.apiKey ?? base.apiKey,
    perServerApiKeys: { ...base.perServerApiKeys, ...(overrides.apiKeys ?? {}) },
    contextOverrides: { ...base.contextOverrides, ...(overrides.contextOverrides ?? {}) },
    defaultContextWindow: overrides.defaultContextWindow ?? base.defaultContextWindow,
    defaultMaxTokens: overrides.defaultMaxTokens ?? base.defaultMaxTokens,
    enableLanScan: overrides.lan ?? base.enableLanScan,
    enableTailscale: overrides.tailscale ?? base.enableTailscale,
  };
}

function loadEnvConfig(env: NodeJS.ProcessEnv): LocalServerConfig {
  return {
    timeoutMs: Number(env.PI_LOCAL_SERVER_TIMEOUT_MS ?? 700),
    detailTimeoutMs: Number(env.PI_LOCAL_SERVER_DETAIL_TIMEOUT_MS ?? 4000),
    extraHosts: parseListEnv(env.PI_LOCAL_SERVER_HOSTS),
    disabledTypes: parseListEnv(env.PI_LOCAL_SERVER_DISABLE).map((s) => s as ServerType),
    defaultContextWindow: Number(env.PI_LOCAL_SERVER_DEFAULT_CTX ?? 32768),
    defaultMaxTokens: Number(env.PI_LOCAL_SERVER_DEFAULT_MAX_TOKENS ?? 32768),
    apiKey: env.PI_LOCAL_SERVER_API_KEY ?? PLACEHOLDER_API_KEY,
    // e.g. PI_LOCAL_SERVER_API_KEYS="192.168.1.10:8080=sk-...,myhost:1234=key"
    perServerApiKeys: parseMapEnv(env.PI_LOCAL_SERVER_API_KEYS),
    // e.g. PI_LOCAL_SERVER_CTX_OVERRIDES="llama-3.1-8b=131072,192.168.1.10:8080/model=32768"
    contextOverrides: parseContextOverridesEnv(env.PI_LOCAL_SERVER_CTX_OVERRIDES),
    enableLanScan: (env.PI_LOCAL_SERVER_NO_LAN ?? "") !== "1",
    enableTailscale: (env.PI_LOCAL_SERVER_NO_TAILSCALE ?? "") !== "1",
  };
}

export function getAgentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR;
  if (override) return override;
  return join(homedir(), ".pi", "agent");
}

export function sanitizeForId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "host";
}

export function providerIdFor(server: DiscoveredServer): string {
  const host = sanitizeForId(server.host);
  return `local-${server.type}-${host}-${server.port}`;
}

export function providerNameFor(server: DiscoveredServer): string {
  const where = server.hostName && server.hostName !== server.host
    ? `${server.hostName} ${server.host}:${server.port}`
    : `${server.host}:${server.port}`;
  return `${server.label} (${where})`;
}

export const PLACEHOLDER_API_KEY = "local";

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * API key to present to `host:port`.
 *
 * A real key is only ever sent where the user pointed it: an exact `host:port` entry in
 * PI_LOCAL_SERVER_API_KEYS, or the global PI_LOCAL_SERVER_API_KEY for loopback and for
 * hosts listed in PI_LOCAL_SERVER_HOSTS. Every other address that auto-discovery happens
 * to find (ARP neighbours, other Tailscale peers, ...) only ever sees the placeholder, so a
 * key can never leak to a random device on the network.
 */
export function apiKeyFor(
  host: string,
  port: number,
  config: LocalServerConfig,
): string {
  const exact = config.perServerApiKeys[`${host}:${port}`];
  if (exact) return exact;
  const trusted = isLoopbackHost(host) || config.extraHosts.includes(host);
  return trusted ? config.apiKey : PLACEHOLDER_API_KEY;
}

/**
 * Bump when the shape or meaning of cached models changes, so entries written
 * by older versions (wrong ctx / maxTokens) are discarded instead of restored.
 */
export const CACHE_VERSION = 3;

export function cacheFilePath(): string {
  return join(getAgentDir(), "pi-local-server-cache.json");
}

/** Local IPv4 addresses (non-internal) for /24 derivation. */
export function localIPv4s(): string[] {
  const out: string[] = [];
  try {
    const ifs = networkInterfaces();
    for (const addrs of Object.values(ifs)) {
      if (!addrs) continue;
      for (const a of addrs) {
        if (a.family === "IPv4" && !a.internal) out.push(a.address);
      }
    }
  } catch {
    // ignore — discovery still works with localhost
  }
  return [...new Set(out)];
}

/** Given 192.168.1.10 -> 192.168.1.0/24 base. Returns [] for non-IPv4. */
export function slash24Base(ip: string): string | null {
  const parts = ip.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d+$/.test(p))) return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}
