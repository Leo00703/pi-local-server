import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadCache, saveCache } from "../../core/cache.js";
import {
  apiKeyFor,
  cacheFilePath,
  isExactContext,
  loadConfig,
  providerIdFor,
  providerNameFor,
  type DiscoveredModel,
  type DiscoveredServer,
  type LocalServerConfig,
  type ServerType,
} from "../../core/config.js";
import { probeMany, type ExecFn } from "../../core/discovery.js";
import { discoverModels, fingerprint } from "../../core/detectors.js";
import { sameModels, scanAll, scanLocal, type FoundServer, type ScanContext } from "../../core/scan.js";

interface ProviderRecord {
  server: DiscoveredServer;
  models: DiscoveredModel[];
}

/** Engines known to honour `stream_options.include_usage` (exact token accounting drives compaction). */
const STREAM_USAGE_TYPES = new Set<ServerType>(["llamacpp", "lmstudio", "ollama", "vllm", "sglang"]);

function toProviderModels(models: DiscoveredModel[], type: ServerType) {
  return models.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    reasoning: m.reasoning,
    input: (m.vision ? ["text", "image"] : ["text"]) as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens" as const,
      ...(STREAM_USAGE_TYPES.has(type) ? { supportsUsageInStreaming: true } : {}),
    },
  }));
}

export default async function (pi: ExtensionAPI) {
  const config: LocalServerConfig = loadConfig();
  const records = new Map<string, ProviderRecord>();
  let backgroundRunning = false;
  // Tailscale peer names, keyed by the address we probe, for readable provider names.
  const hostNames = new Map<string, string>();

  const execFn: ExecFn = async (cmd, args) => {
    const res = (await pi.exec(cmd, args, { timeout: 5000 })) as { stdout?: unknown };
    return { stdout: typeof res.stdout === "string" ? res.stdout : "" };
  };

  const persist = () =>
    saveCache(cacheFilePath(), [...records.values()].map(({ server, models }) => ({ server, models })));

  /**
   * (Re)register a provider from its current record. Used for live discovery, cache
   * restore and dynamic refresh, so all three behave identically.
   */
  function publishProvider(providerId: string): void {
    const rec = records.get(providerId);
    if (!rec) return;
    const { server } = rec;
    pi.registerProvider(providerId, {
      name: providerNameFor(server),
      baseUrl: server.baseUrl,
      apiKey: apiKeyFor(server.host, server.port, config),
      api: "openai-completions",
      models: toProviderModels(rec.models, server.type),
      async refreshModels({ signal }: { signal: AbortSignal }) {
        try {
          if ((await refreshRecord(providerId, signal)).changed) await persist();
        } catch {
          // keep the last known models
        }
        const current = records.get(providerId) ?? rec;
        return toProviderModels(current.models, server.type);
      },
    });
  }

  /**
   * Re-read a server's models from the server itself. The context window is whatever the
   * server is running with *right now* (it changes every time a model is reloaded with a
   * different --ctx-size / context length), so nothing here is trusted from an earlier run.
   * Unreachable or empty answers keep the last known models.
   */
  async function refreshRecord(
    providerId: string,
    signal?: AbortSignal,
  ): Promise<{ changed: boolean; before?: DiscoveredModel[]; after?: DiscoveredModel[] }> {
    const rec = records.get(providerId);
    if (!rec) return { changed: false };
    const { server } = rec;
    const hits = await probeMany([{ host: server.host, port: server.port }], config, signal, 4);
    const live = hits[0];
    // A different engine now answers on this port: a rescan will register it properly.
    if (!live || fingerprint(live).type !== server.type) return { changed: false };
    const fresh = await discoverModels(live, server.type, `${server.host}:${server.port}`, config, signal);
    if (fresh.length === 0) return { changed: false };
    const changed = !sameModels(rec.models, fresh);
    if (changed) records.set(providerId, { server, models: fresh });
    return { changed, before: rec.models, after: fresh };
  }

  const lastChecked = new Map<string, number>();

  /** Before the agent uses a local model, make sure its context window is still what the server runs. */
  async function refreshActive(
    model: { provider?: string; id?: string } | undefined,
    minIntervalMs: number,
    notify?: (msg: string) => void,
  ): Promise<void> {
    const providerId = model?.provider;
    if (!providerId || !records.has(providerId)) return;
    const now = Date.now();
    if (now - (lastChecked.get(providerId) ?? 0) < minIntervalMs) return;
    lastChecked.set(providerId, now);
    try {
      const r = await refreshRecord(providerId, AbortSignal.timeout(3000));
      if (!r.changed) return;
      publishProvider(providerId);
      void persist();
      const was = r.before?.find((m) => m.id === model.id);
      const is = r.after?.find((m) => m.id === model.id);
      if (was && is && was.contextWindow !== is.contextWindow) {
        notify?.(`pi-local-server: ${model.id} context window ${was.contextWindow} → ${is.contextWindow}`);
      }
    } catch {
      // never block the agent on a refresh
    }
  }

  /** Register a freshly discovered server as soon as it is identified. */
  function scanContext(signal?: AbortSignal): ScanContext {
    return {
      config,
      exec: execFn,
      ...(signal ? { signal } : {}),
      hostNames,
      onFound: ({ providerId, server, models }: FoundServer) => {
        records.set(providerId, { server, models });
        publishProvider(providerId);
      },
    };
  }

  function statusText(): string {
    if (records.size === 0) {
      return "pi-local-server: no local servers registered yet. Run /local-server rescan.";
    }
    const lines: string[] = [`pi-local-server: ${records.size} provider(s)`];
    for (const [id, rec] of records) {
      const inexact = rec.models.filter((m) => !isExactContext(m.contextSource)).length;
      const est = inexact > 0 ? ` (${inexact} ctx not verified)` : "";
      lines.push(`- ${id} @ ${rec.server.origin} [${rec.server.type}/${rec.server.source}] ${rec.models.length} model(s)${est}`);
    }
    return lines.join("\n");
  }

  // Cache restore first, so a new laptop is usable before the network sweep ends; then a fast
  // pass over this machine and the configured hosts. The full LAN + Tailscale sweep runs in
  // session_start (background).
  try {
    for (const entry of await loadCache(cacheFilePath())) {
      const server: DiscoveredServer = { ...entry.server, source: "cache" };
      if (config.disabledTypes.includes(server.type) || entry.models.length === 0) continue;
      const providerId = providerIdFor(server);
      records.set(providerId, { server, models: entry.models });
      publishProvider(providerId);
    }
  } catch {
    // Cache restore never breaks startup.
  }
  try {
    await scanLocal(scanContext());
    await persist();
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
          const { found, scannedHosts, warnings } = await scanAll(scanContext(ctx.signal ?? undefined));
          await persist();
          const added = [...records.keys()].filter((k) => !before.has(k)).length;
          if (ctx.hasUI) {
            for (const w of warnings) ctx.ui.notify(`pi-local-server: ${w}`, "warning");
            ctx.ui.notify(
              found.size > 0
                ? `pi-local-server: found ${found.size} provider(s) (${added} new, ${scannedHosts} hosts scanned). See /model.`
                : "pi-local-server: no servers found. Check server is running + reachable, then /local-server hosts.",
              found.size > 0 ? "info" : "warning",
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
    // Registration is idempotent per providerId, so this never duplicates.
    const before = records.size;
    backgroundRunning = true;
    if (ctx.hasUI) ctx.ui.setStatus("pi-local-server", "Scanning LAN for local servers…");
    try {
      const { found } = await scanAll(scanContext(ctx.signal ?? undefined));
      await persist();
      if (found.size > before && ctx.hasUI) {
        ctx.ui.notify(`pi-local-server: found ${found.size} server(s). Run /model to select.`, "info");
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

  // The context window is not a constant: it changes whenever a server is restarted or a
  // model reloaded with another context size. Re-check the active local model just before
  // the agent uses it (throttled), and right when the user picks it.
  pi.on("before_agent_start", async (_event, ctx) => {
    await refreshActive(ctx.model, 5000, (m) => ctx.hasUI && ctx.ui.notify(m, "info"));
  });
  pi.on("turn_start", async (_event, ctx) => {
    await refreshActive(ctx.model, 5000, (m) => ctx.hasUI && ctx.ui.notify(m, "info"));
  });
  pi.on("model_select", async (event, ctx) => {
    await refreshActive(event.model, 0, (m) => ctx.hasUI && ctx.ui.notify(m, "info"));
  });

  pi.on("session_shutdown", async () => {
    backgroundRunning = false;
  });
}
