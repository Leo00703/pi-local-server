import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig } from "../core/config.js";
import {
  discoverModels,
  effectiveLlamaContext,
  maxTokensFor,
  parseLlamaLaunchSettings,
} from "../core/detectors.js";
import type { LiveOrigin } from "../core/discovery.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as unknown;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Serve canned JSON per path (query included); anything else is a 404. */
function stubFetch(routes: Record<string, unknown>): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const key = url.pathname + url.search;
    calls.push(key);
    if (key in routes) return new Response(JSON.stringify(routes[key]), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return calls;
}

const config = loadConfig();
const origin = "http://127.0.0.1:8080";
const live = (extra: Partial<LiveOrigin>): LiveOrigin => ({
  origin,
  host: "127.0.0.1",
  port: 8080,
  latencyMs: 1,
  ...extra,
});

describe("llama.cpp launch args", () => {
  it("reads --ctx-size, -c and --ctx-size=N", () => {
    assert.equal(parseLlamaLaunchSettings(["x", "--ctx-size", "4096"], undefined).ctxSize, 4096);
    assert.equal(parseLlamaLaunchSettings(["-c", "8192"], undefined).ctxSize, 8192);
    assert.equal(parseLlamaLaunchSettings(["--ctx-size=16384"], undefined).ctxSize, 16384);
  });

  it("falls back to the preset text", () => {
    const s = parseLlamaLaunchSettings(undefined, "[m]\nctx-size = 65536\nparallel = 2\n");
    assert.equal(s.ctxSize, 65536);
    assert.equal(s.parallel, 2);
  });

  it("treats --ctx-size 0 as unknown (taken from the model)", () => {
    assert.equal(parseLlamaLaunchSettings(["--ctx-size", "0"], undefined).ctxSize, null);
  });

  it("splits the context across explicit slots unless the KV cache is unified", () => {
    assert.equal(effectiveLlamaContext(parseLlamaLaunchSettings(["-c", "65536", "-np", "4"], "")), 16384);
    assert.equal(effectiveLlamaContext(parseLlamaLaunchSettings(["-c", "65536", "-np", "4", "--kv-unified"], "")), 65536);
    assert.equal(effectiveLlamaContext(parseLlamaLaunchSettings(["-c", "65536"], "")), 65536);
  });
});

describe("llama.cpp router mode (real Llama-macOS output)", () => {
  it("uses the launch --ctx-size, not the 128000 training context", async () => {
    stubFetch({ "/props": fixture("llamacpp-router-props.json") });
    const models = await discoverModels(
      live({ v1Models: fixture("llamacpp-router-models.json") }),
      "llamacpp",
      "127.0.0.1:8080",
      config,
    );
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    assert.equal(byId["org/vision-small:Q8_0"]!.contextWindow, 4096);
    assert.equal(byId["org/text-large:Q8_0"]!.contextWindow, 131072);
    assert.equal(byId["org/vision-medium:Q8_0"]!.contextWindow, 8192);
    for (const m of models) assert.equal(m.contextSource, "launch-args");
  });

  it("derives maxTokens from the context and keeps it below it", async () => {
    stubFetch({ "/props": fixture("llamacpp-router-props.json") });
    const models = await discoverModels(
      live({ v1Models: fixture("llamacpp-router-models.json") }),
      "llamacpp",
      "127.0.0.1:8080",
      config,
    );
    const small = models.find((m) => m.contextWindow === 4096)!;
    assert.equal(small.maxTokens, 2048);
    const big = models.find((m) => m.contextWindow === 131072)!;
    assert.equal(big.maxTokens, 32768);
  });

  it("detects image input from architecture.input_modalities", async () => {
    stubFetch({ "/props": fixture("llamacpp-router-props.json") });
    const models = await discoverModels(
      live({ v1Models: fixture("llamacpp-router-models.json") }),
      "llamacpp",
      "127.0.0.1:8080",
      config,
    );
    assert.equal(models.find((m) => m.id.startsWith("org/vision-small"))!.vision, true);
    assert.equal(models.find((m) => m.id.startsWith("org/text-large"))!.vision, false);
  });

  it("asks a loaded model's own /props, and never an unloaded one", async () => {
    const list = fixture("llamacpp-router-models.json") as { data: Array<Record<string, any>> };
    list.data[0]!.status.value = "loaded";
    const calls = stubFetch({
      "/props": fixture("llamacpp-router-props.json"),
      [`/props?model=${encodeURIComponent(list.data[0]!.id)}`]: { default_generation_settings: { n_ctx: 3000 } },
    });
    const models = await discoverModels(live({ v1Models: list }), "llamacpp", "127.0.0.1:8080", config);
    assert.equal(models.find((m) => m.id === list.data[0]!.id)!.contextWindow, 3000);
    assert.equal(models.find((m) => m.id === list.data[0]!.id)!.contextSource, "server");
    assert.equal(calls.filter((c) => c.startsWith("/props?model=")).length, 1);
  });

  it("falls back to the training context only as 'model-max' when no args exist", async () => {
    stubFetch({ "/props": fixture("llamacpp-router-props.json") });
    const models = await discoverModels(
      live({ v1Models: { data: [{ id: "m", context_length: 128000 }] } }),
      "llamacpp",
      "127.0.0.1:8080",
      config,
    );
    assert.equal(models[0]!.contextWindow, 128000);
    assert.equal(models[0]!.contextSource, "model-max");
  });
});

describe("llama.cpp single-model mode", () => {
  it("uses /props n_ctx", async () => {
    stubFetch({
      "/props": { default_generation_settings: { n_ctx: 32768 }, modalities: { vision: true } },
    });
    const models = await discoverModels(
      live({ v1Models: { data: [{ id: "Single Model 27B", context_length: 262144 }] } }),
      "llamacpp",
      "127.0.0.1:8080",
      config,
    );
    assert.equal(models[0]!.contextWindow, 32768);
    assert.equal(models[0]!.contextSource, "server");
    assert.equal(models[0]!.vision, true);
  });
});

describe("overrides and caps", () => {
  it("user context override beats everything", async () => {
    stubFetch({ "/props": fixture("llamacpp-router-props.json") });
    const cfg = { ...config, contextOverrides: { "127.0.0.1:8080/org/vision-small:Q8_0": 16000 } };
    const models = await discoverModels(
      live({ v1Models: fixture("llamacpp-router-models.json") }),
      "llamacpp",
      "127.0.0.1:8080",
      cfg,
    );
    assert.equal(models.find((m) => m.id.startsWith("org/vision-small"))!.contextWindow, 16000);
  });

  it("maxTokens is always below the context window", () => {
    for (const ctx of [2, 512, 4096, 1_000_000]) {
      assert.ok(maxTokensFor(ctx, config) < Math.max(ctx, 2));
      assert.ok(maxTokensFor(ctx, config) >= 1);
    }
    assert.equal(maxTokensFor(8192, { ...config, defaultMaxTokens: Number.NaN }), 4096);
  });
});
