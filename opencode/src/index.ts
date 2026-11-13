import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Config, Plugin, PluginModule } from "@opencode-ai/plugin";
import { loadCache, sameMachineKey, saveCache } from "../../core/cache.js";
import { loadConfig, providerIdFor, type ConfigOverrides, type LocalServerConfig } from "../../core/config.js";
import { discoverModels, fingerprint } from "../../core/detectors.js";
import { probeMany, type ExecFn } from "../../core/discovery.js";
import { sameModels, scanAll, toCacheEntry, verifyKnown, type FoundServer } from "../../core/scan.js";
import { toOpenCodeProvider, toV2Entry, type V2ProviderEntry } from "./provider.js";

const run = promisify(execFile);

const exec: ExecFn = async (cmd, args) => {
  const { stdout } = await run(cmd, args, { timeout: 5000, windowsHide: true });
  return { stdout: String(stdout) };
};

export function cacheFilePath(): string {
  const base =
    process.platform === "win32"
      ? (process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
      : (process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"));
  return join(base, "opencode-local-server", "cache.json");
}

/** Plugin options (`["opencode-local-server", { hosts: [...] }]`) -> the shared config overrides. */
export function overridesFromOptions(options: Record<string, unknown> | undefined): ConfigOverrides {
  const o = options ?? {};
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const map = <T>(v: unknown, ok: (x: unknown) => x is T) =>
    v && typeof v === "object"
      ? (Object.fromEntries(Object.entries(v).filter(([, x]) => ok(x))) as Record<string, T>)
      : {};
  const out: ConfigOverrides = {
    hosts: list(o.hosts),
    disable: list(o.disable),
    apiKeys: map(o.apiKeys, (x): x is string => typeof x === "string"),
    contextOverrides: map(o.contextOverrides, (x): x is number => typeof x === "number"),
  };
  if (typeof o.apiKey === "string") out.apiKey = o.apiKey;
  if (typeof o.defaultContextWindow === "number") out.defaultContextWindow = o.defaultContextWindow;
  if (typeof o.defaultMaxTokens === "number") out.defaultMaxTokens = o.defaultMaxTokens;
  if (typeof o.lan === "boolean") out.lan = o.lan;
  if (typeof o.tailscale === "boolean") out.tailscale = o.tailscale;
  return out;
}

/**
 * Discover servers without making OpenCode wait for a network sweep.
 *
 * With a cache from an earlier run (the normal case), only the quick paths block startup: this
 * machine, the Tailscale peers, and a direct re-check of every server seen before (~1-2 s). The
 * slow LAN sweep then runs in the background and updates the cache for next time. The very first
 * run, with no cache, does the full sweep within the time budget.
 *
 * Whatever is found is always read from the server right now, so context windows are current each
 * time OpenCode loads its config. Servers seen before that do not answer are kept from the cache.
 */
export async function discover(
  config: LocalServerConfig,
  options: { cachePath?: string; budgetMs?: number; execFn?: ExecFn; log?: (message: string) => void } = {},
): Promise<FoundServer[]> {
  const cachePath = options.cachePath ?? cacheFilePath();
  const execFn = options.execFn ?? exec;
  const cached = await loadCache(cachePath);
  const found = new Map<string, FoundServer>();
  const started = Date.now();

  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), options.budgetMs ?? 5000);
  const ctx = (signal: AbortSignal | undefined, cfg = config) => ({
    config: cfg,
    exec: execFn,
    hostNames: new Map<string, string>(),
    ...(signal ? { signal } : {}),
  });

  try {
    if (cached.length > 0) {
      const [scan, verified] = await Promise.all([
        scanAll(ctx(budget.signal, { ...config, enableLanScan: false })),
        verifyKnown(cached, ctx(budget.signal)),
      ]);
      for (const [id, f] of [...verified, ...scan.found]) found.set(id, f);
    } else {
      for (const [id, f] of (await scanAll(ctx(budget.signal))).found) found.set(id, f);
    }
    options.log?.(
      `found ${found.size} server(s) in ${Date.now() - started} ms` +
        (budget.signal.aborted ? " (time budget reached)" : "") +
        (cached.length > 0 ? "; LAN sweep continues in the background" : ""),
    );
  } catch (error) {
    options.log?.(`scan failed after ${Date.now() - started} ms: ${String(error)}`);
  } finally {
    clearTimeout(timer);
  }

  const keep = (extra: Iterable<FoundServer>) => {
    const all = new Map(found);
    for (const f of extra) if (!all.has(f.providerId)) all.set(f.providerId, f);
    // Remembered servers that did not answer are kept, but not as a second copy of a machine that
    // did (its LAN address cached, its Tailscale address found now). Each keeps the time it was last
    // really seen, so a server that has been gone for a week drops out (see loadCache).
    const live = new Set([...all.values()].map((f) => sameMachineKey(f.server, f.models)));
    for (const entry of cached) {
      const id = providerIdFor(entry.server);
      if (all.has(id) || config.disabledTypes.includes(entry.server.type) || entry.models.length === 0) continue;
      if (live.has(sameMachineKey(entry.server, entry.models))) continue;
      all.set(id, { providerId: id, server: { ...entry.server, source: "cache" }, models: entry.models, seenAt: entry.seenAt });
    }
    return all;
  };

  const result = keep([]);
  await saveCache(cachePath, [...result.values()].map(toCacheEntry));

  if (cached.length > 0 && config.enableLanScan) {
    // Not awaited: finds LAN servers for the next start without delaying this one.
    const background = new AbortController();
    const bgTimer = setTimeout(() => background.abort(), 60_000);
    void scanAll(ctx(background.signal))
      .then(async (scan) => {
        const merged = keep(scan.found.values());
        for (const [id, f] of scan.found) merged.set(id, f);
        await saveCache(cachePath, [...merged.values()].map(toCacheEntry));
      })
      .catch(() => {})
      .finally(() => clearTimeout(bgTimer));
  }
  return [...result.values()];
}

/** Add the discovered servers to OpenCode's config without overriding anything the user defined. */
export function applyToConfig(oc: Config, servers: FoundServer[], config: LocalServerConfig): string[] {
  const added: string[] = [];
  const disabled = new Set(oc.disabled_providers ?? []);
  oc.provider ??= {};
  for (const found of servers) {
    if (oc.provider[found.providerId] || disabled.has(found.providerId)) continue;
    oc.provider[found.providerId] = toOpenCodeProvider(found, config);
    added.push(found.providerId);
  }
  return added;
}

const server: Plugin = async (input, options) => {
  const config = loadConfig(process.env, overridesFromOptions(options));
  const ours = new Map<string, FoundServer>();
  const lastChecked = new Map<string, number>();

  const log = (level: "info" | "warn", message: string) => {
    if (process.env.OPENCODE_LOCAL_SERVER_DEBUG) console.error(`[opencode-local-server] ${level}: ${message}`);
    void input.client.app
      .log({ body: { service: "opencode-local-server", level, message } })
      .catch(() => {});
  };

  return {
    config: async (oc) => {
      const servers = await discover(config, { log: (m) => log("info", m) });
      for (const id of applyToConfig(oc, servers, config)) {
        const found = servers.find((s) => s.providerId === id);
        if (found) ours.set(id, found);
      }
    },

    // OpenCode reads the context window once, when it loads its config. If the server was
    // restarted with a smaller context since, keep the request from asking for more output than
    // fits and say so, instead of letting the server truncate or fail silently.
    "chat.params": async (hook, output) => {
      const known = ours.get(hook.model.providerID);
      if (!known) return;
      const now = Date.now();
      if (now - (lastChecked.get(known.providerId) ?? 0) < 5000) return;
      lastChecked.set(known.providerId, now);
      try {
        const [live] = await probeMany(
          [{ host: known.server.host, port: known.server.port }],
          config,
          AbortSignal.timeout(3000),
          1,
        );
        if (!live || fingerprint(live).type !== known.server.type) return;
        const fresh = (
          await discoverModels(live, known.server.type, `${known.server.host}:${known.server.port}`, config)
        ).find((m) => m.id === hook.model.id);
        const declared = hook.model.limit.context;
        if (!fresh || fresh.contextWindow >= declared) return;
        output.maxOutputTokens = Math.min(output.maxOutputTokens ?? Infinity, Math.floor(fresh.contextWindow / 2));
        log(
          "warn",
          `${hook.model.id} now runs with a ${fresh.contextWindow}-token context but OpenCode loaded ${declared}; restart OpenCode to refresh its limits.`,
        );
      } catch {
        // never block a request on the check
      }
    },
  };
};

// --- OpenCode 2.x -----------------------------------------------------------------------------
// 2.x replaced the hooks above with `Plugin.define({ id, setup(ctx) })`; a module may export both,
// each OpenCode generation uses the one it knows. Here providers are registered through
// ctx.provider.transform and refreshed with ctx.provider.reload(), so unlike 1.x the context
// window follows a server that was restarted with another size while OpenCode keeps running.

interface V2Context {
  options?: Record<string, unknown>;
  provider: {
    transform(callback: (editor: { add(entry: V2ProviderEntry): void }) => void): Promise<unknown>;
    reload(): Promise<void>;
  };
}

const REFRESH_MS = 60_000;
const FULL_SCAN_EVERY = 5; // every 5th refresh also looks for servers started after OpenCode

async function setup(ctx: V2Context): Promise<() => void> {
  const config = loadConfig(process.env, overridesFromOptions(ctx.options));
  const debug = (message: string) => {
    if (process.env.OPENCODE_LOCAL_SERVER_DEBUG) console.error(`[opencode-local-server] ${message}`);
  };
  let servers = new Map((await discover(config, { log: debug })).map((f) => [f.providerId, f] as const));

  await ctx.provider.transform((editor) => {
    for (const found of servers.values()) editor.add(toV2Entry(found, config));
  });

  let tick = 0;
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        const signal = AbortSignal.timeout(15_000);
        const scanCtx = { config, exec, hostNames: new Map<string, string>(), signal };
        const fresh = new Map(servers);
        const full = ++tick % FULL_SCAN_EVERY === 0;
        const seen = full
          ? (await scanAll(scanCtx)).found
          : await verifyKnown([...servers.values()], scanCtx);
        for (const [id, f] of seen) fresh.set(id, f);
        const changed =
          fresh.size !== servers.size ||
          [...fresh].some(([id, f]) => !servers.has(id) || !sameModels(servers.get(id)!.models, f.models));
        if (!changed) return;
        servers = fresh;
        debug(`servers changed (${servers.size}); reloading providers`);
        await ctx.provider.reload();
        await saveCache(cacheFilePath(), [...servers.values()].map(toCacheEntry));
      } catch {
        // keep serving the last known providers
      } finally {
        busy = false;
      }
    })();
  }, REFRESH_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

const definition = { id: "opencode-local-server", server, setup };
export default definition satisfies PluginModule | typeof definition;
