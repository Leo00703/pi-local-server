import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CACHE_VERSION, type DiscoveredModel, type DiscoveredServer } from "./config.js";

export interface CacheEntry {
  server: DiscoveredServer;
  models: DiscoveredModel[];
}

/** Last-known servers, so a new session is usable before the network sweep ends. Best effort only. */
export async function loadCache(path: string): Promise<CacheEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { version?: number; entries?: CacheEntry[] };
    // Entries from older versions carry wrong ctx/maxTokens: start clean instead.
    if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter((e) => e && typeof e === "object" && e.server && Array.isArray(e.models));
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
