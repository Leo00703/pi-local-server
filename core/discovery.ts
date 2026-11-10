import { apiKeyFor, localIPv4s, slash24Base, type LocalServerConfig } from "./config.js";

export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// Many servers (LM Studio among them) answer *unknown* paths with HTTP 200 and an
// `{"error": ...}` body. "Got JSON" therefore proves nothing: each probe must check
// that the payload has the shape of the API it is looking for, or a server gets
// fingerprinted as the wrong engine (LM Studio was being registered as Ollama).
export const isOpenAIModelList = (d: unknown): boolean => isRecord(d) && Array.isArray(d.data);
export const isOllamaTags = (d: unknown): boolean => isRecord(d) && Array.isArray(d.models);
export const isLlamaProps = (d: unknown): boolean =>
  isRecord(d) &&
  !("error" in d) &&
  ("default_generation_settings" in d || "build_info" in d || "role" in d);
export const isLmStudioModelList = (d: unknown): boolean => {
  if (!isOpenAIModelList(d)) return false;
  const first = (d as { data: unknown[] }).data[0];
  return isRecord(first) && ("state" in first || "max_context_length" in first);
};

async function fetchJson(
  url: string,
  timeoutMs: number,
  outerSignal?: AbortSignal,
  headers?: Record<string, string>,
  validate?: (data: unknown) => boolean,
): Promise<{ ok: boolean; status: number; data?: unknown }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onOuterAbort = () => ctrl.abort();
  if (outerSignal) {
    if (outerSignal.aborted) {
      clearTimeout(timer);
      return { ok: false, status: 0 };
    }
    outerSignal.addEventListener("abort", onOuterAbort, { once: true });
  }
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      // Never follow redirects: a probe (which may carry an API key) must not be
      // bounced to a host we did not choose to talk to.
      redirect: "manual",
      headers: { accept: "application/json", ...headers },
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status };
    try {
      const data = JSON.parse(text) as unknown;
      if (validate && !validate(data)) return { ok: false, status: res.status };
      return { ok: true, status: res.status, data };
    } catch {
      return { ok: false, status: res.status };
    }
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
}

export async function probeV1Models(
  origin: string,
  timeoutMs: number,
  signal?: AbortSignal,
  apiKey?: string,
): Promise<{ ok: boolean; status: number; data?: unknown }> {
  const headers: Record<string, string> = {};
  if (apiKey && apiKey !== "local") headers.authorization = `Bearer ${apiKey}`;
  // Jan requires *some* key; send dummy to avoid 401 hiding a live server.
  return fetchJson(
    `${origin}/v1/models`,
    timeoutMs,
    signal,
    { ...headers, authorization: headers.authorization ?? "Bearer local" },
    isOpenAIModelList,
  );
}

export async function probeOllamaTags(
  origin: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; data?: unknown }> {
  return fetchJson(`${origin}/api/tags`, timeoutMs, signal, undefined, isOllamaTags);
}

export async function probeLlamaProps(
  origin: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; data?: unknown }> {
  return fetchJson(`${origin}/props`, timeoutMs, signal, undefined, isLlamaProps);
}

export async function probeLmStudioModels(
  origin: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; data?: unknown }> {
  return fetchJson(`${origin}/api/v0/models`, timeoutMs, signal, undefined, isLmStudioModelList);
}

export function parseArpIps(output: string): string[] {
  const ips = new Set<string>();
  const re = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g;
  for (const line of output.split(/\r?\n/)) {
    // Windows prints "Interface: <this PC's own address> --- 0x5" before each block: not a neighbour.
    if (/^\s*Interface:/i.test(line)) continue;
    for (const m of line.matchAll(re)) {
      const ip = m[1]!;
      if (ip.endsWith(".255") || ip === "0.0.0.0") continue;
      const first = Number(ip.split(".")[0]);
      if (first >= 224) continue; // multicast / reserved: never a model server
      ips.add(ip);
    }
  }
  return [...ips];
}

export async function getArpLiveHosts(exec: ExecFn | undefined): Promise<string[]> {
  if (!exec) return [];
  try {
    // `arp -a` works on Windows, macOS and Linux (different output, same regex).
    const { stdout } = await exec("arp", ["-a"]);
    return parseArpIps(stdout).slice(0, 64);
  } catch {
    return [];
  }
}

interface TailscaleStatusJson {
  Self?: { HostName?: string; DNSName?: string; TailscaleIPs?: string[] };
  Peer?: Record<
    string,
    { HostName?: string; DNSName?: string; TailscaleIPs?: string[]; Online?: boolean; CurAddr?: string }
  >;
}

export interface TailscalePeer {
  /** What we connect to: the tailnet IPv4 (stable, no MagicDNS needed), else the DNS name. */
  address: string;
  /** Short machine name for display, e.g. `desktop`. */
  name: string;
  /** The peer's LAN IPv4 when Tailscale talks to it directly (status `CurAddr`), else undefined. */
  lanAddress?: string;
}

/**
 * One entry per online peer. Previously both the DNS name and the IP of a peer were
 * probed, which registered the same server twice under two different providers.
 */
export function parseTailscalePeers(jsonText: string): TailscalePeer[] {
  try {
    const parsed = JSON.parse(jsonText) as TailscaleStatusJson;
    const out: TailscalePeer[] = [];
    const seen = new Set<string>();
    for (const p of Object.values(parsed.Peer ?? {})) {
      if (p.Online === false) continue;
      const dns = p.DNSName?.replace(/\.$/, "");
      const ip4 = (p.TailscaleIPs ?? []).find((ip) => ip.includes("."));
      const address = ip4 ?? dns ?? p.HostName;
      if (!address || seen.has(address)) continue;
      seen.add(address);
      const lan = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(p.CurAddr ?? "")?.[1];
      out.push({ address, name: p.HostName || dns?.split(".")[0] || address, ...(lan ? { lanAddress: lan } : {}) });
    }
    return out.slice(0, 64);
  } catch {
    return [];
  }
}

export function parseTailscaleHosts(jsonText: string): string[] {
  return parseTailscalePeers(jsonText).map((p) => p.address);
}

/**
 * Where the Tailscale CLI lives. The GUI installs on macOS and Windows do not put it
 * on PATH (macOS: inside Tailscale.app), so `tailscale` alone silently finds nothing.
 */
export function tailscaleCliCandidates(platform: NodeJS.Platform = process.platform): string[] {
  const list = ["tailscale"];
  if (platform === "darwin") {
    list.push("/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale");
  } else if (platform === "win32") {
    list.push(
      "C:\\Program Files\\Tailscale\\tailscale.exe",
      "C:\\Program Files (x86)\\Tailscale\\tailscale.exe",
    );
  } else {
    list.push("/usr/bin/tailscale", "/usr/local/bin/tailscale", "/snap/bin/tailscale");
  }
  return list;
}

export async function getTailscalePeers(
  exec: ExecFn | undefined,
  platform: NodeJS.Platform = process.platform,
): Promise<TailscalePeer[]> {
  if (!exec) return [];
  for (const cmd of tailscaleCliCandidates(platform)) {
    try {
      const { stdout } = await exec(cmd, ["status", "--json"]);
      const peers = parseTailscalePeers(stdout);
      if (peers.length > 0) return peers;
    } catch {
      // binary not here / not running: try the next known location
    }
  }
  return [];
}

export async function getTailscaleHosts(exec: ExecFn | undefined): Promise<string[]> {
  return (await getTailscalePeers(exec)).map((p) => p.address);
}

/** Unique ports from enabled defs (cap to keep scans fast). */
export function uniquePorts(portsPerDef: number[][], cap = 24): number[] {
  const set = new Set<number>();
  for (const ports of portsPerDef) for (const p of ports) set.add(p);
  return [...set].slice(0, cap);
}

export interface HostPort {
  host: string;
  port: number;
}

export function localhostCandidates(ports: number[]): HostPort[] {
  // Only 127.0.0.1 — probing both it and `localhost` registers duplicate
  // providers for the same instance.
  return ports.map((port) => ({ host: "127.0.0.1", port }));
}

export function lanCandidates(hosts: string[], ports: number[]): HostPort[] {
  return hosts.flatMap((host) => ports.map((port) => ({ host, port })));
}

/** Full /24 sweep for one base, e.g. 192.168.1 -> .1..254 (used only as fallback). */
export function slash24Candidates(base: string, ports: number[]): HostPort[] {
  const out: HostPort[] = [];
  for (let i = 1; i <= 254; i++) {
    const host = `${base}.${i}`;
    for (const port of ports) out.push({ host, port });
  }
  return out;
}

export function localSlash24Bases(): string[] {
  const bases = new Set<string>();
  for (const ip of localIPv4s()) {
    const base = slash24Base(ip);
    if (base) bases.add(base);
  }
  return [...bases];
}

/** Simple concurrency-limited map. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface LiveOrigin {
  origin: string;
  host: string;
  port: number;
  latencyMs: number;
  v1Models?: unknown;
  ollamaTags?: unknown;
  llamaProps?: unknown;
  /** LM Studio's native `GET /api/v0/models` (state, loaded_context_length, type, ...). */
  lmStudioModels?: unknown;
}

export async function probeHostPort(
  hp: HostPort,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  apiKey: string,
): Promise<LiveOrigin | null> {
  const origin = `http://${hp.host}:${hp.port}`;
  const start = Date.now();
  // Probe both endpoints in parallel on every port: Ollama exposes /v1/models
  // AND /api/tags (also on custom ports), so skipping /api/tags misclassifies
  // it as generic/vLLM. Keep both payloads so fingerprint() sees everything.
  const [v1, tags] = await Promise.all([
    probeV1Models(origin, timeoutMs, signal, apiKey),
    probeOllamaTags(origin, timeoutMs, signal),
  ]);
  if (v1.ok || tags.ok) {
    const latencyMs = Date.now() - start;
    // Identify the engine: only on origins that are really alive, so the sweep stays cheap.
    const [props, lms] = await Promise.all([
      probeLlamaProps(origin, timeoutMs, signal),
      probeLmStudioModels(origin, timeoutMs, signal),
    ]);
    return {
      origin,
      host: hp.host,
      port: hp.port,
      latencyMs,
      ...(v1.ok ? { v1Models: v1.data } : {}),
      ...(tags.ok ? { ollamaTags: tags.data } : {}),
      ...(props.ok ? { llamaProps: props.data } : {}),
      ...(lms.ok ? { lmStudioModels: lms.data } : {}),
    };
  }
  // llama.cpp single-model with empty /v1/models still answers /props.
  const props = await probeLlamaProps(origin, timeoutMs, signal);
  if (props.ok) {
    return { origin, host: hp.host, port: hp.port, latencyMs: Date.now() - start, llamaProps: props.data };
  }
  return null;
}

/** Loopback, RFC1918, link-local, Tailscale/CGNAT (100.64/10), MagicDNS and LAN-style names. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1") return true;
  if (/^(fe80|fc|fd)/.test(h) && h.includes(":")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (!h.includes(".")) return true; // bare hostname on the LAN / tailnet (e.g. desktop)
  return /\.(ts\.net|local|lan|home\.arpa|internal)$/.test(h);
}

export async function probeMany(
  list: HostPort[],
  config: LocalServerConfig,
  signal?: AbortSignal,
  concurrency = 64,
): Promise<LiveOrigin[]> {
  const seen = new Set<string>();
  const normalizeHost = (h: string) => (h === "localhost" ? "127.0.0.1" : h);
  const deduped = list.filter((hp) => {
    // Auto-discovery only ever talks to private addresses. A public host is probed
    // only when the user listed it explicitly in PI_LOCAL_SERVER_HOSTS.
    if (!isPrivateHost(hp.host) && !config.extraHosts.includes(hp.host)) return false;
    const key = `${normalizeHost(hp.host)}:${hp.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const found: LiveOrigin[] = [];
  await mapLimit(deduped, concurrency, async (hp) => {
    if (signal?.aborted) return;
    const hit = await probeHostPort(hp, config.timeoutMs, signal, apiKeyFor(hp.host, hp.port, config));
    if (hit) found.push(hit);
  });
  return found;
}
