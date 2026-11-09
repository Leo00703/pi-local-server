import { afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type DiscoveredServer } from "../core/config.js";
import type { FoundServer } from "../core/scan.js";
import plugin, { applyToConfig, overridesFromOptions } from "../opencode/src/index.js";
import { toOpenCodeProvider } from "../opencode/src/provider.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const server: DiscoveredServer = {
  type: "strata",
  label: "Strata",
  host: "100.64.0.2",
  port: 8080,
  origin: "http://100.64.0.2:8080",
  baseUrl: "http://100.64.0.2:8080/v1",
  latencyMs: 5,
  source: "tailscale",
  hostName: "DESKTOP",
};
const found: FoundServer = {
  providerId: "local-strata-100-64-0-2-8080",
  server,
  models: [
    { id: "big", contextWindow: 204800, contextSource: "server", maxTokens: 32768, reasoning: true, vision: true },
    { id: "small", contextWindow: 4096, contextSource: "launch-args", maxTokens: 2048, reasoning: false },
  ],
};

describe("OpenCode provider mapping", () => {
  const config = loadConfig({});
  const p = toOpenCodeProvider(found, config);

  it("targets the OpenAI-compatible endpoint, without the default 5 min timeout", () => {
    assert.equal(p.npm, "@ai-sdk/openai-compatible");
    assert.equal(p.options.baseURL, "http://100.64.0.2:8080/v1");
    assert.equal(p.options.apiKey, "local");
    assert.equal(p.options.timeout, false);
    assert.equal(p.name, "Strata (DESKTOP 100.64.0.2:8080)");
  });

  it("carries the real context window, output budget and modalities per model", () => {
    assert.deepEqual(p.models.big!.limit, { context: 204800, output: 32768 });
    assert.deepEqual(p.models.big!.modalities.input, ["text", "image"]);
    assert.equal(p.models.big!.reasoning, true);
    assert.deepEqual(p.models.small!.limit, { context: 4096, output: 2048 });
    assert.deepEqual(p.models.small!.modalities.input, ["text"]);
    assert.equal(p.models.small!.tool_call, true);
  });
});

describe("applying to OpenCode's config", () => {
  const config = loadConfig({});

  it("adds providers but never overrides one the user defined or disabled", () => {
    const mine = { name: "mine" };
    const oc = { provider: { [found.providerId]: mine }, disabled_providers: ["local-other"] } as never;
    const other: FoundServer = { ...found, providerId: "local-other" };
    const third: FoundServer = { ...found, providerId: "local-third" };
    const added = applyToConfig(oc, [found, other, third], config);
    assert.deepEqual(added, ["local-third"]);
    assert.equal((oc as { provider: Record<string, unknown> }).provider[found.providerId], mine);
  });

  it("creates the provider map when OpenCode has none", () => {
    const oc = {} as { provider?: Record<string, unknown> };
    applyToConfig(oc as never, [found], config);
    assert.ok(oc.provider?.[found.providerId]);
  });
});

describe("plugin options", () => {
  it("maps options to shared config overrides and ignores wrong types", () => {
    const o = overridesFromOptions({
      hosts: ["pc", 5],
      apiKeys: { "pc:8080": "k", bad: 1 },
      contextOverrides: { m: 8192, n: "x" },
      disable: ["ollama"],
      lan: false,
      defaultContextWindow: 16384,
      apiKey: "g",
    });
    assert.deepEqual(o.hosts, ["pc"]);
    assert.deepEqual(o.apiKeys, { "pc:8080": "k" });
    assert.deepEqual(o.contextOverrides, { m: 8192 });
    assert.deepEqual(o.disable, ["ollama"]);
    assert.equal(o.lan, false);
    assert.equal(o.defaultContextWindow, 16384);
    assert.equal(o.apiKey, "g");
  });

  it("loadConfig merges overrides over the environment", () => {
    const c = loadConfig({ PI_LOCAL_SERVER_HOSTS: "a" }, { hosts: ["b"], tailscale: false });
    assert.deepEqual(c.extraHosts, ["a", "b"]);
    assert.equal(c.enableTailscale, false);
  });
});

describe("plugin hooks (config + chat.params)", () => {
  const live = { nCtx: 8192, up: true };
  const logs: string[] = [];
  let hooks: Awaited<ReturnType<typeof plugin.server>>;
  const oc: { provider?: Record<string, { models: Record<string, { limit: { context: number } }> }> } = {};

  // The file-level afterEach restores the real fetch; each test needs the stub back.
  const installStub = () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (!live.up || url.host !== "192.168.77.5:8080") throw new TypeError("connection refused");
      const routes: Record<string, unknown> = {
        "/v1/models": { data: [{ id: "m" }] },
        "/props": { default_generation_settings: { n_ctx: live.nCtx }, build_info: "b1" },
      };
      return url.pathname in routes
        ? new Response(JSON.stringify(routes[url.pathname]), { status: 200 })
        : new Response("{}", { status: 404 });
    }) as typeof fetch;
  };
  beforeEach(installStub);

  before(async () => {
    process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "oc-local-server-"));
    process.env.LOCALAPPDATA = process.env.XDG_CACHE_HOME;
    installStub();
    hooks = await plugin.server(
      { client: { app: { log: async ({ body }: { body: { message: string } }) => void logs.push(body.message) } } } as never,
      { hosts: ["192.168.77.5"], lan: false, tailscale: false },
    );
    await hooks.config!(oc as never);
  });

  it("registers the discovered server with its real context in OpenCode's config", () => {
    const id = "local-llamacpp-192-168-77-5-8080";
    assert.equal(oc.provider?.[id]?.models.m?.limit.context, 8192);
  });

  it("clamps output and warns when the server now runs a smaller context", async () => {
    live.nCtx = 2048;
    const output = { temperature: 0, topP: 1, topK: 0, maxOutputTokens: 32768 as number | undefined, options: {} };
    await hooks["chat.params"]!(
      { model: { id: "m", providerID: "local-llamacpp-192-168-77-5-8080", limit: { context: 8192, output: 4096 } } } as never,
      output,
    );
    assert.equal(output.maxOutputTokens, 1024);
    assert.ok(logs.some((l) => l.includes("2048") && l.includes("8192")), logs.join("|"));
  });

  it("ignores models that are not ours", async () => {
    const output = { temperature: 0, topP: 1, topK: 0, maxOutputTokens: 100 as number | undefined, options: {} };
    await hooks["chat.params"]!({ model: { id: "x", providerID: "anthropic", limit: { context: 1, output: 1 } } } as never, output);
    assert.equal(output.maxOutputTokens, 100);
  });
});
