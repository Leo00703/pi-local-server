import { apiKeyFor, localIPv4s, slash24Base, type LocalServerConfig } from "./config.js";

export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

async function fetchJson(
  url: string,
  timeoutMs: number,
  outerSignal?: AbortSignal,
  headers?: Record<string, string>,
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
      headers: { accept: "application/json", ...headers },
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status };
    try {
      return { ok: true, status: res.status, data: JSON.parse(text) as unknown };
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
  return fetchJson(`${origin}/v1/models`, timeoutMs, signal, {
    ...headers,
    authorization: headers.authorization ?? "Bearer local",
  });
}

export async function probeOllamaTags(
  origin: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; data?: unknown }> {
  return fetchJson(`${origin}/api/tags`, timeoutMs, signal);
}

export async function probeLlamaProps(
  origin: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; data?: unknown }> {
  return fetchJson(`${origin}/props`, timeoutMs, signal);
}

export function parseArpIps(output: string): string[] {
  const ips = new Set<string>();
  const re = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    const ip = m[1]!;
    if (ip.endsWith(".255") || ip === "0.0.0.0") continue;
    ips.add(ip);
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
    { HostName?: string; DNSName?: string; TailscaleIPs?: string[]; Online?: boolean }
  >;
}

export function parseTailscaleHosts(jsonText: string): string[] {
  try {
    const parsed = JSON.parse(jsonText) as TailscaleStatusJson;
    const out = new Set<string>();
    const peers = parsed.Peer ?? {};
    for (const p of Object.values(peers)) {
      if (p.Online === false) continue;
      if (p.DNSName) out.add(p.DNSName.replace(/\.$/, ""));
      else if (p.HostName) out.add(p.HostName);
      for (const ip of p.TailscaleIPs ?? []) {
        if (ip.includes(".")) out.add(ip);
      }
    }
    return [...out].slice(0, 64);
  } catch {
    return [];
  }
}

export async function getTailscaleHosts(exec: ExecFn | undefined): Promise<string[]> {
  if (!exec) return [];
  const candidates: Array<[string, string[]]> = [
    ["tailscale", ["status", "--json"]],
    ["tailscaled", ["status", "--json"]],
  ];
  for (const [cmd, args] of candidates) {
    try {
      const { stdout } = await exec(cmd, args);
      const hosts = parseTailscaleHosts(stdout);
      if (hosts.length > 0) return hosts;
    } catch {
      // try next binary name, then give up silently
    }
  }
  return [];
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
    return {
      origin,
      host: hp.host,
      port: hp.port,
      latencyMs: Date.now() - start,
      ...(v1.ok ? { v1Models: v1.data } : {}),
      ...(tags.ok ? { ollamaTags: tags.data } : {}),
    };
  }
  // llama.cpp single-model with empty /v1/models still answers /props.
  const props = await probeLlamaProps(origin, timeoutMs, signal);
  if (props.ok) {
    return { origin, host: hp.host, port: hp.port, latencyMs: Date.now() - start, llamaProps: props.data };
  }
  return null;
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
