import {
  SERVER_DEFS,
  localIPv4s,
  providerIdFor,
  type DiscoveredModel,
  type DiscoveredServer,
  type LocalServerConfig,
} from "./config.js";
import {
  getArpLiveHosts,
  getTailscalePeers,
  lanCandidates,
  localhostCandidates,
  localSlash24Bases,
  mapLimit,
  probeMany,
  slash24Candidates,
  uniquePorts,
  type ExecFn,
  type LiveOrigin,
} from "./discovery.js";
import { discoverModels, fingerprint } from "./detectors.js";
import type { CacheEntry } from "./cache.js";

const COMMON_FALLBACK_PORTS = [8080, 1234, 11434, 8000, 1337, 30000, 4000, 5000, 2242];

export interface FoundServer {
  providerId: string;
  server: DiscoveredServer;
  models: DiscoveredModel[];
  /** When a live probe confirmed it (ms). Set by every scan; a server restored from the cache keeps its old value. */
  seenAt?: number;
}

export interface ScanContext {
  config: LocalServerConfig;
  /** Runs a command (arp, tailscale). Without it the LAN and Tailscale phases find nothing. */
  exec?: ExecFn;
  signal?: AbortSignal;
  /** Tailscale peer names keyed by probed address; filled during a full scan. */
  hostNames?: Map<string, string>;
  /** Called for every server as soon as it is identified. */
  onFound?: (found: FoundServer) => void;
  /** This machine's own addresses (default: its network interfaces). A server found there is the local one. */
  ownAddresses?: Iterable<string>;
}

function enabledPorts(config: LocalServerConfig): number[] {
  const enabled = SERVER_DEFS.filter((d) => !config.disabledTypes.includes(d.type));
  return uniquePorts(enabled.map((d) => d.ports));
}

/** Identify one live origin and read its models. Null when disabled, empty or failing. */
export async function resolveLive(
  live: LiveOrigin,
  source: DiscoveredServer["source"],
  ctx: ScanContext,
): Promise<FoundServer | null> {
  const { config } = ctx;
  const fp = fingerprint(live);
  if (config.disabledTypes.includes(fp.type)) return null;
  try {
    const models = await discoverModels(live, fp.type, `${live.host}:${live.port}`, config, ctx.signal);
    if (models.length === 0) return null;
    const hostName = ctx.hostNames?.get(live.host);
    const server: DiscoveredServer = {
      type: fp.type,
      label: fp.label,
      host: live.host,
      port: live.port,
      origin: live.origin,
      baseUrl: `${live.origin}/v1`,
      latencyMs: live.latencyMs,
      source,
      ...(hostName ? { hostName } : {}),
    };
    return { providerId: providerIdFor(server), server, models, seenAt: Date.now() };
  } catch {
    return null;
  }
}

async function collect(
  hits: LiveOrigin[],
  sourceFor: (live: LiveOrigin) => DiscoveredServer["source"],
  ctx: ScanContext,
  out: Map<string, FoundServer>,
  emit = false,
): Promise<void> {
  await mapLimit(hits, 8, async (live) => {
    const found = await resolveLive(live, sourceFor(live), ctx);
    if (!found) return;
    out.set(found.providerId, found);
    if (emit) ctx.onFound?.(found);
  });
}

/** Phase 0: this machine plus the hosts the user listed. Fast enough to run at startup. */
export async function scanLocal(ctx: ScanContext): Promise<Map<string, FoundServer>> {
  const { config } = ctx;
  const ports = enabledPorts(config);
  const out = new Map<string, FoundServer>();
  const hits = await probeMany(
    [...localhostCandidates(ports), ...lanCandidates(config.extraHosts, ports)],
    config,
    ctx.signal,
    32,
  );
  await collect(hits, (live) => (config.extraHosts.includes(live.host) ? "config" : "localhost"), ctx, out, true);
  return out;
}

export interface ScanResult {
  found: Map<string, FoundServer>;
  scannedHosts: number;
  /** Human-readable hints when nothing was found. */
  warnings: string[];
}

/** A command that hangs (a firewalled `arp`, a stopped tailscaled) must not eat the whole scan budget. */
async function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Local + LAN (ARP, /24 fallback) + Tailscale peers. LAN and tailnet are scanned concurrently. */
export async function scanAll(ctx: ScanContext): Promise<ScanResult> {
  const { config } = ctx;
  const ports = enabledPorts(config);
  const warnings: string[] = [];
  const found = await scanLocal(ctx);
  // LAN and tailnet hits are held back until the end: the same machine is often reachable both
  // ways, and it must show up once (as its stable tailnet address), not as two providers.
  const lanFound = new Map<string, FoundServer>();
  const tailFound = new Map<string, FoundServer>();
  // Never scan ourselves by LAN/tailnet address: it is the same server localhost already found.
  const own = new Set(ctx.ownAddresses ?? localIPv4s());
  const peerLanAddresses = new Set<string>();
  let scannedHosts = 1 + config.extraHosts.length;
  let peerCount = 0;

  const lan = async () => {
    if (!config.enableLanScan) return;
    const arpHosts = (await withTimeout(getArpLiveHosts(ctx.exec), 2500, [])).filter((h) => !own.has(h));
    scannedHosts += arpHosts.length;
    if (arpHosts.length > 0) {
      const hits = await probeMany(lanCandidates(arpHosts, ports), config, ctx.signal, 64);
      await collect(hits, () => "lan", ctx, lanFound);
    }
  };

  // Tailscale peers are always scanned, so LAN and tailnet servers coexist as separate providers.
  const tailnet = async () => {
    if (!config.enableTailscale) return;
    // A peer the user listed by name or address is probed through that entry only.
    const explicit = new Set(config.extraHosts.map((h) => h.toLowerCase()));
    const peers = (await withTimeout(getTailscalePeers(ctx.exec), 4000, [])).filter(
      (p) => !explicit.has(p.name.toLowerCase()) && !explicit.has(p.address.toLowerCase()),
    );
    peerCount = peers.length;
    for (const peer of peers) {
      ctx.hostNames?.set(peer.address, peer.name);
      if (peer.lanAddress) peerLanAddresses.add(peer.lanAddress);
    }
    if (peers.length > 0) {
      scannedHosts += peers.length;
      const hits = await probeMany(lanCandidates(peers.map((p) => p.address), ports), config, ctx.signal, 32);
      await collect(hits, () => "tailscale", ctx, tailFound);
    }
  };

  await Promise.all([lan(), tailnet()]);

  // Tailscale only reports a peer's direct LAN address once traffic has flowed to it, and we have just
  // probed every peer: read the status again so the same machine is not listed under both addresses.
  if (config.enableTailscale) {
    for (const peer of await withTimeout(getTailscalePeers(ctx.exec), 2500, [])) {
      if (peer.lanAddress) peerLanAddresses.add(peer.lanAddress);
    }
  }

  const settle = (map: Map<string, FoundServer>, skipHosts?: Set<string>) => {
    for (const [id, f] of map) {
      if (own.has(f.server.host) || skipHosts?.has(f.server.host) || found.has(id)) continue;
      found.set(id, f);
      ctx.onFound?.(f);
    }
  };
  settle(tailFound);
  settle(lanFound, peerLanAddresses); // drop LAN hits that are just a tailnet peer's direct address

  // /24 sweep on common ports only as a last resort: nothing at all found so far.
  if (config.enableLanScan && found.size === 0) {
    const sweepPorts = ports.filter((p) => COMMON_FALLBACK_PORTS.includes(p));
    for (const base of localSlash24Bases().slice(0, 2)) {
      const sweep = slash24Candidates(base, sweepPorts.length > 0 ? sweepPorts : ports.slice(0, 9));
      scannedHosts += 254;
      await collect(await probeMany(sweep, config, ctx.signal, 64), () => "lan", ctx, found, true);
      if (found.size > 0) break;
    }
  }

  if (found.size === 0) {
    if (config.enableTailscale && peerCount === 0) warnings.push("no LAN servers and no Tailscale peers detected.");
    warnings.push("scan found nothing. Check the server is running and reachable (listening on 0.0.0.0, firewall open).");
  }
  return { found, scannedHosts, warnings };
}

/**
 * Re-verify servers seen before (cache) by asking each one directly: one probe per server instead of a
 * network sweep. Servers that do not answer are simply absent from the result.
 */
export async function verifyKnown(
  entries: Array<{ server: DiscoveredServer }>,
  ctx: ScanContext,
): Promise<Map<string, FoundServer>> {
  const out = new Map<string, FoundServer>();
  await mapLimit(entries, 8, async ({ server }) => {
    const [live] = await probeMany([{ host: server.host, port: server.port }], ctx.config, ctx.signal, 1);
    if (!live) return;
    const hostNames = new Map(server.hostName ? [[server.host, server.hostName] as [string, string]] : []);
    const found = await resolveLive(live, server.source, { ...ctx, hostNames });
    if (found) out.set(found.providerId, found);
  });
  return out;
}

/** The cache line for a found server: confirmed now unless it carries the time of an earlier probe. */
export function toCacheEntry(f: FoundServer): CacheEntry {
  return { server: f.server, models: f.models, seenAt: f.seenAt ?? Date.now() };
}

/** Two model lists that matter the same to an agent: ids, context, output budget, vision, reasoning. */
export function sameModels(a: DiscoveredModel[], b: DiscoveredModel[]): boolean {
  if (a.length !== b.length) return false;
  const key = (m: DiscoveredModel) =>
    `${m.id}|${m.contextWindow}|${m.maxTokens}|${m.vision ? 1 : 0}|${m.reasoning ? 1 : 0}`;
  const left = new Set(a.map(key));
  return b.every((m) => left.has(key(m)));
}
