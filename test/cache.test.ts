import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CACHE_MAX_AGE_MS,
  hostRank,
  loadCache,
  sameMachineKey,
  saveCache,
  usableEntries,
  type CacheEntry,
} from "../core/cache.js";
import { CACHE_VERSION, loadConfig, type DiscoveredModel, type DiscoveredServer } from "../core/config.js";
import { discover } from "../opencode/src/index.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 14, 12);

const model = (id: string): DiscoveredModel => ({
  id,
  contextWindow: 8192,
  contextSource: "server",
  maxTokens: 4096,
  reasoning: false,
});
const server = (host: string, source: DiscoveredServer["source"] = "lan", type: DiscoveredServer["type"] = "strata", port = 8080): DiscoveredServer => ({
  type,
  label: "Strata",
  host,
  port,
  origin: `http://${host}:${port}`,
  baseUrl: `http://${host}:${port}/v1`,
  latencyMs: 1,
  source,
});
const entry = (host: string, ageMs: number, models = ["m"], source: DiscoveredServer["source"] = "lan"): CacheEntry => ({
  server: server(host, source),
  models: models.map(model),
  seenAt: NOW - ageMs,
});

describe("remembered servers: expiry", () => {
  it("drops a server not seen for more than a week, keeps a recent one", () => {
    const out = usableEntries([entry("192.168.1.5", 8 * DAY), entry("192.168.1.6", 6 * DAY, ["other"])], NOW);
    assert.deepEqual(out.map((e) => e.server.host), ["192.168.1.6"]);
    assert.equal(CACHE_MAX_AGE_MS, 7 * DAY);
  });

  it("drops entries without a last-seen time", () => {
    const legacy = { server: server("192.168.1.5"), models: [model("m")] } as unknown as CacheEntry;
    assert.deepEqual(usableEntries([legacy], NOW), []);
  });
});

describe("remembered servers: one entry per machine", () => {
  it("keeps the Tailscale address and drops the LAN copy of the same machine", () => {
    const out = usableEntries([entry("192.168.1.12", DAY), entry("100.64.0.2", 2 * DAY, ["m"], "tailscale")], NOW);
    assert.deepEqual(out.map((e) => e.server.host), ["100.64.0.2"]);
  });

  it("prefers this machine over Tailscale over the LAN", () => {
    assert.equal(hostRank("127.0.0.1"), 0);
    assert.equal(hostRank("100.100.5.5"), 1);
    assert.equal(hostRank("pc.example.ts.net"), 1);
    assert.equal(hostRank("100.128.0.1"), 2);
    assert.equal(hostRank("192.168.1.5"), 2);
  });

  it("keeps machines that differ in models, port or engine", () => {
    const a = entry("192.168.1.5", DAY, ["x"]);
    const b = entry("192.168.1.6", DAY, ["y"]);
    const c: CacheEntry = { ...entry("192.168.1.7", DAY, ["x"]), server: server("192.168.1.7", "lan", "llamacpp") };
    const d: CacheEntry = { ...entry("192.168.1.8", DAY, ["x"]), server: server("192.168.1.8", "lan", "strata", 8095) };
    assert.equal(usableEntries([a, b, c, d], NOW).length, 4);
    assert.notEqual(sameMachineKey(a.server, a.models), sameMachineKey(c.server, c.models));
  });
});

describe("cache file", () => {
  let dir = "";
  afterEach(() => void (dir = ""));
  const file = () => join((dir ||= mkdtempSync(join(tmpdir(), "cache-test-"))), "cache.json");

  it("round-trips entries with their last-seen time", async () => {
    const e = entry("100.64.0.2", 0, ["m"], "tailscale");
    await saveCache(file(), [e]);
    const back = await loadCache(file(), NOW);
    assert.deepEqual(back.map((x) => [x.server.host, x.seenAt]), [["100.64.0.2", NOW]]);
  });

  it("ignores a cache written by an older version (no last-seen times, stale duplicates)", async () => {
    writeFileSync(file(), JSON.stringify({ version: CACHE_VERSION - 1, entries: [entry("192.168.1.12", 0)] }));
    assert.deepEqual(await loadCache(file(), NOW), []);
  });
});

describe("OpenCode plugin: stale servers", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  // Every server is down: whatever comes back is from the cache.
  const allDown = () => {
    globalThis.fetch = (async () => {
      throw new TypeError("connection refused");
    }) as typeof fetch;
  };
  const config = { ...loadConfig({}), extraHosts: [], enableLanScan: false, enableTailscale: false };

  it("lists a machine once, drops what expired, and does not refresh the last-seen time of what it did not reach", async () => {
    allDown();
    const path = join(mkdtempSync(join(tmpdir(), "oc-cache-")), "cache.json");
    const fresh = Date.now() - DAY;
    const entries: CacheEntry[] = [
      { server: server("100.64.0.2", "tailscale"), models: [model("m")], seenAt: fresh },
      { server: server("192.168.1.12", "lan"), models: [model("m")], seenAt: fresh },
      { server: server("192.168.1.99", "lan"), models: [model("gone")], seenAt: Date.now() - 9 * DAY },
    ];
    writeFileSync(path, JSON.stringify({ version: CACHE_VERSION, savedAt: Date.now(), entries }));

    const out = await discover(config, { cachePath: path, execFn: async () => ({ stdout: "" }) });

    assert.deepEqual(out.map((f) => f.server.host), ["100.64.0.2"]);
    const saved = JSON.parse(readFileSync(path, "utf8")) as { entries: CacheEntry[] };
    assert.deepEqual(saved.entries.map((e) => [e.server.host, e.seenAt]), [["100.64.0.2", fresh]]);
  });
});
