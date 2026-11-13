import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CACHE_VERSION, type DiscoveredModel, type DiscoveredServer } from "./config.js";

export interface CacheEntry {
  server: DiscoveredServer;
  models: DiscoveredModel[];
  /** When a live probe last confirmed this server (ms since epoch). Never refreshed by a cache restore. */
  seenAt: number;
}

/** A server not seen for this long is forgotten instead of being offered for ever. */
export const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** 0 = this machine, 1 = Tailscale, 2 = anything else: the order to keep addresses of one machine in. */
export function hostRank(host: string): number {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "::1" || /^127\./.test(h)) return 0;
  if (h.endsWith(".ts.net")) return 1;
  const m = /^(\d{1,3})\.(\d{1,3})\./.exec(h);
  if (m && Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127) return 1;
  return 2;
}

/**
 * What makes two cached servers one machine seen at two addresses (its LAN and its Tailscale
 * address): same engine, same port, same models. Only used on remembered servers, never on live
 * ones: a live probe of two addresses is told apart by the Tailscale peer list (see scan.ts).
 */
export function sameMachineKey(server: { type: string; port: number }, models: Array<{ id: string }>): string {
  return `${server.type}|${server.port}|${models.map((m) => m.id).sort().join("|")}`;
}

/**
 * The remembered servers worth offering: seen within [CACHE_MAX_AGE_MS], and one entry per machine
 * (this machine, then Tailscale, then the rest). Newest first within a machine.
 */
export function usableEntries(entries: CacheEntry[], now = Date.now()): CacheEntry[] {
  const fresh = entries
    .filter((e) => typeof e.seenAt === "number" && now - e.seenAt <= CACHE_MAX_AGE_MS)
    .sort((a, b) => hostRank(a.server.host) - hostRank(b.server.host) || b.seenAt - a.seenAt);
  const seen = new Set<string>();
  const out: CacheEntry[] = [];
  for (const e of fresh) {
    const key = sameMachineKey(e.server, e.models);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/** Last-known servers, so a new session is usable before the network sweep ends. Best effort only. */
export async function loadCache(path: string, now = Date.now()): Promise<CacheEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { version?: number; entries?: CacheEntry[] };
    // Entries from older versions carry wrong ctx/maxTokens (or no last-seen time): start clean instead.
    if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) return [];
    return usableEntries(
      parsed.entries.filter((e) => e && typeof e === "object" && e.server && Array.isArray(e.models)),
      now,
    );
  } catch {
    return [];
  }
}

export async function saveCache(path: string, entries: CacheEntry[]): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ version: CACHE_VERSION, savedAt: Date.now(), entries }, null, 2));
  } catch {
    // Cache is best-effort only.
  }
}
