import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  SERVER_DEFS,
  apiKeyFor,
  cacheFilePath,
  loadConfig,
  providerIdFor,
  providerNameFor,
  type DiscoveredModel,
  type DiscoveredServer,
  type LocalServerConfig,
} from "./config.js";
import {
  getArpLiveHosts,
  getTailscaleHosts,
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

interface ProviderRecord {
  server: DiscoveredServer;
  models: DiscoveredModel[];
}

const COMMON_FALLBACK_PORTS = [8080, 1234, 11434, 8000, 1337, 30000, 4000, 5000, 2242];

interface CacheEntry {
  server: DiscoveredServer;
  models: DiscoveredModel[];
}

async function loadCache(): Promise<CacheEntry[]> {
  try {
    const text = await readFile(cacheFilePath(), "utf8");
    const parsed = JSON.parse(text) as { entries?: CacheEntry[] };
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter(
      (e) => e && typeof e === "object" && e.server && Array.isArray(e.models),
    );
  } catch {
    return [];
  }
}

async function saveCache(records: Map<string, ProviderRecord>): Promise<void> {
  try {
    const entries = [...records.values()].map(({ server, models }) => ({ server, models }));
    await mkdir(dirname(cacheFilePath()), { recursive: true });
    await writeFile(cacheFilePath(), JSON.stringify({ savedAt: Date.now(), entries }, null, 2));
  } catch {
    // Cache is best-effort only.
  }
}

function toProviderModels(models: DiscoveredModel[]) {
  return models.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    reasoning: m.reasoning,
    input: ["text"] as ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  }));
}

export default async function (pi: ExtensionAPI) {
  const config: LocalServerConfig = loadConfig();
  const records = new Map<string, ProviderRecord>();
  let backgroundRunning = false;

  const execFn: ExecFn = async (cmd, args) => {
    const res = (await pi.exec(cmd, args, { timeout: 5000 })) as { stdout?: unknown };
    return { stdout: typeof res.stdout === "string" ? res.stdout : "" };
  };

  function registerLive(
    live: LiveOrigin,
    source: DiscoveredServer["source"],
    models: DiscoveredModel[],
  ): string | null {
    if (models.length === 0) return null;
    const fp = fingerprint(live);
    if (config.disabledTypes.includes(fp.type)) return null;
    const server: DiscoveredServer = {
      type: fp.type,
      label: fp.label,
      host: live.host,
      port: live.port,
      origin: live.origin,
      baseUrl: `${live.origin}/v1`,
      latencyMs: live.latencyMs,
      source,
    };
    const providerId = providerIdFor(server);
    const serverKey = `${server.host}:${server.port}`;
    records.set(providerId, { server, models });

    // Dynamic refresh: re-probe this origin on model refresh (no hardcoding).
    pi.registerProvider(providerId, {
      name: providerNameFor(server),
      baseUrl: server.baseUrl,
      apiKey: apiKeyFor(server.host, server.port, config),
      api: "openai-completions",
      models: toProviderModels(models),
      async refreshModels({ signal }: { signal: AbortSignal }) {
        try {
          const hits = await probeMany(
            [{ host: server.host, port: server.port }],
            config,
            signal,
            4,
          );
          if (hits.length === 0) return toProviderModels(models);
          const fresh = await discoverModels(hits[0]!, fp.type, serverKey, config, signal);
          if (fresh.length === 0) return toProviderModels(models);
          records.set(providerId, { server, models: fresh });
          return toProviderModels(fresh);
        } catch {
          return toProviderModels(models);
        }
      },
    });
    return providerId;
  }

  async function resolveLive(
    live: LiveOrigin,
    source: DiscoveredServer["source"],
    signal?: AbortSignal,
  ): Promise<string | null> {
    const fp = fingerprint(live);
    if (config.disabledTypes.includes(fp.type)) return null;
    const serverKey = `${live.host}:${live.port}`;
    try {
      const models = await discoverModels(live, fp.type, serverKey, config, signal);
      return registerLive(live, source, models);
    } catch {
      return null;
    }
  }

  async function fastScan(signal?: AbortSignal): Promise<number> {
    const enabled = SERVER_DEFS.filter((d) => !config.disabledTypes.includes(d.type));
    const ports = uniquePorts(enabled.map((d) => d.ports));
    const candidates = [
      ...localhostCandidates(ports),
      ...lanCandidates(config.extraHosts, ports),
    ];
    const hits = await probeMany(candidates, config, signal, 32);
    let registered = 0;
    await mapLimit(hits, 8, async (live) => {
      const source: DiscoveredServer["source"] = config.extraHosts.includes(live.host)
        ? "config"
        : "localhost";
      if (await resolveLive(live, source, signal)) registered++;
    });
    return registered;
  }

  async function fullScan(
    signal?: AbortSignal,
    notify?: (msg: string, kind: "info" | "warning" | "error") => void,
  ): Promise<{ registered: number; scannedHosts: number }> {
    const enabled = SERVER_DEFS.filter((d) => !config.disabledTypes.includes(d.type));
    const ports = uniquePorts(enabled.map((d) => d.ports));
    const foundIds = new Set<string>();
    let scannedHosts = 0;

    async function collect(
      hits: LiveOrigin[],
      sourceFor: (live: LiveOrigin) => DiscoveredServer["source"],
    ): Promise<void> {
      await mapLimit(hits, 8, async (live) => {
        const id = await resolveLive(live, sourceFor(live), signal);
        if (id) foundIds.add(id);
      });
    }

    // Phase 0: localhost + configured hosts (so rescan covers same-laptop too).
    {
      const candidates = [
        ...localhostCandidates(ports),
        ...lanCandidates(config.extraHosts, ports),
      ];
      scannedHosts += 1 + config.extraHosts.length;
      const hits = await probeMany(candidates, config, signal, 32);
      await collect(hits, (live) =>
        config.extraHosts.includes(live.host) ? "config" : "localhost",
      );
    }

    // Phase 1: LAN live hosts via arp (fast, no blind sweep).
    if (config.enableLanScan) {
      const arpHosts = await getArpLiveHosts(execFn);
      scannedHosts += arpHosts.length;
      if (arpHosts.length > 0) {
        const hits = await probeMany(lanCandidates(arpHosts, ports), config, signal, 64);
        await collect(hits, () => "lan");
      }
      // Phase 1b: /24 sweep fallback on common ports if nothing found so far.
      if (foundIds.size === 0) {
        const bases = localSlash24Bases();
        const sweepPorts = ports.filter((p) => COMMON_FALLBACK_PORTS.includes(p));
        for (const base of bases.slice(0, 2)) {
          const sweep = slash24Candidates(base, sweepPorts.length > 0 ? sweepPorts : ports.slice(0, 9));
          scannedHosts += 254;
          const hits = await probeMany(sweep, config, signal, 64);
          await collect(hits, () => "lan");
          if (foundIds.size > 0) break;
        }
      }
    }

    // Phase 2: Tailscale peers — always scanned (LAN hits no longer skip it),
    // so LAN + Tailscale servers coexist as separate providers.
    if (config.enableTailscale) {
      const tails = await getTailscaleHosts(execFn);
      if (tails.length > 0) {
        scannedHosts += tails.length;
        const hits = await probeMany(lanCandidates(tails, ports), config, signal, 32);
        await collect(hits, () => "tailscale");
      } else if (foundIds.size === 0) {
        notify?.("pi-local-server: no LAN servers and no Tailscale peers detected.", "warning");
      }
    }

    if (foundIds.size === 0) {
      notify?.(
        "pi-local-server: scan found nothing. Check server is running + reachable, then /local-server hosts.",
        "warning",
      );
    }
    await saveCache(records);
    return { registered: foundIds.size, scannedHosts };
  }

  function statusText(): string {
    if (records.size === 0) {
      return "pi-local-server: no local servers registered yet. Run /local-server rescan.";
    }
    const lines: string[] = [`pi-local-server: ${records.size} provider(s)`];
    for (const [id, rec] of records) {
      const estimated = rec.models.filter((m) => m.contextSource === "estimated").length;
      const est = estimated > 0 ? ` (${estimated} ctx estimated)` : "";
      lines.push(`- ${id} @ ${rec.server.origin} [${rec.server.type}/${rec.server.source}] ${rec.models.length} model(s)${est}`);
    }
    return lines.join("\n");
  }

  // Fast localhost pass during startup so providers exist for /model immediately,
  // plus cache restore so a new laptop is usable before the network sweep ends.
  // Full LAN + Tailscale sweep runs in session_start (background, non-blocking).
  try {
    const cached = await loadCache();
    for (const entry of cached) {
      const server: DiscoveredServer = { ...entry.server, source: "cache" };
      if (config.disabledTypes.includes(server.type)) continue;
      const providerId = providerIdFor(server);
      const serverKey = `${server.host}:${server.port}`;
      const models = entry.models;
      if (models.length === 0) continue;
      records.set(providerId, { server, models });
      pi.registerProvider(providerId, {
        name: providerNameFor(server),
        baseUrl: server.baseUrl,
        apiKey: apiKeyFor(server.host, server.port, config),
        api: "openai-completions",
        models: toProviderModels(models),
        async refreshModels({ signal }: { signal: AbortSignal }) {
          try {
            const hits = await probeMany(
              [{ host: server.host, port: server.port }],
              config,
              signal,
              4,
            );
            if (hits.length === 0) return toProviderModels(models);
            const fresh = await discoverModels(hits[0]!, fingerprint(hits[0]!).type, serverKey, config, signal);
            if (fresh.length === 0) return toProviderModels(models);
            records.set(providerId, { server, models: fresh });
            await saveCache(records);
            return toProviderModels(fresh);
          } catch {
            return toProviderModels(models);
          }
        },
      });
    }
  } catch {
    // Cache restore never breaks startup.
  }
  try {
    await fastScan();
    await saveCache(records);
  } catch {
    // Startup must never fail because a local server is down.
  }

  pi.registerCommand("local-server", {
    description: "Discover local LLM servers (LAN first, then Tailscale) and register providers",
    getArgumentCompletions: (prefix: string) => {
      const items = ["status", "rescan", "hosts"].map((v) => ({ value: v, label: v }));
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "status";
      if (sub === "hosts") {
        const msg = `localhost + ${config.extraHosts.length} configured host(s)` +
          (config.extraHosts.length > 0 ? `: ${config.extraHosts.join(", ")}` : " (set PI_LOCAL_SERVER_HOSTS=host1,host2 for Tailscale/LAN names)");
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        return;
      }
      if (sub === "rescan") {
        if (backgroundRunning) {
          if (ctx.hasUI) ctx.ui.notify("pi-local-server: scan already running", "warning");
          return;
        }
        backgroundRunning = true;
        if (ctx.hasUI) ctx.ui.setStatus("pi-local-server", "Scanning LAN + Tailscale…");
        try {
          const before = new Set(records.keys());
          const { registered, scannedHosts } = await fullScan(ctx.signal ?? undefined, (msg, kind) => {
            if (ctx.hasUI) ctx.ui.notify(msg, kind);
          });
          const added = [...records.keys()].filter((k) => !before.has(k)).length;
          if (ctx.hasUI) {
            ctx.ui.notify(
              registered > 0
                ? `pi-local-server: found ${registered} provider(s) (${added} new, ${scannedHosts} hosts scanned). See /model.`
                : "pi-local-server: no servers found. Check server is running + reachable, then /local-server hosts.",
              registered > 0 ? "info" : "warning",
            );
          }
        } finally {
          backgroundRunning = false;
          if (ctx.hasUI) ctx.ui.setStatus("pi-local-server", undefined);
        }
        return;
      }
      if (ctx.hasUI) ctx.ui.notify(statusText(), "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (backgroundRunning) return;
    // Always background-sweep (even if localhost/cache already registered) so a
    // new laptop finds the main PC on LAN/Tailscale without manual rescan.
    // registerLive() is idempotent per providerId, so this never duplicates.
    const before = records.size;
    backgroundRunning = true;
    if (ctx.hasUI) ctx.ui.setStatus("pi-local-server", "Scanning LAN for local servers…");
    try {
      const { registered } = await fullScan(ctx.signal ?? undefined);
      if (registered > before && ctx.hasUI) {
        ctx.ui.notify(`pi-local-server: found ${registered} server(s). Run /model to select.`, "info");
      }
    } catch {
      // Background discovery never breaks the session.
    } finally {
      backgroundRunning = false;
      try {
        if (ctx.hasUI) ctx.ui.setStatus("pi-local-server", undefined);
      } catch {
        // ignore teardown races
      }
    }
  });

  pi.on("session_shutdown", async () => {
    backgroundRunning = false;
  });
}
