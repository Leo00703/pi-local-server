import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig } from "../core/config.js";
import { discoverModels, fingerprint } from "../core/detectors.js";
import { probeHostPort } from "../core/discovery.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as unknown;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * LM Studio answers every unknown path with HTTP 200 and {"error": ...}. Reproduce that:
 * known paths return their fixture, anything else is a 200 error body.
 */
function stubLmStudio(overrides: Record<string, unknown> = {}): void {
  const routes: Record<string, unknown> = {
    "/v1/models": fixture("lmstudio-v1-models.json"),
    "/api/v0/models": fixture("lmstudio-v0-models.json"),
    ...overrides,
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    const body = path in routes ? routes[path] : { error: `Unexpected endpoint or method. (GET ${path})` };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

const config = loadConfig();

describe("LM Studio identification", () => {
  it("is not mistaken for Ollama when /api/tags answers 200 with an error body", async () => {
    stubLmStudio();
    const live = await probeHostPort({ host: "127.0.0.1", port: 1234 }, 500, undefined, "local");
    assert.ok(live);
    assert.equal(live.ollamaTags, undefined);
    assert.equal(live.llamaProps, undefined);
    assert.ok(live.lmStudioModels);
    assert.equal(fingerprint(live).type, "lmstudio");
  });
});

describe("LM Studio context", () => {
  async function models() {
    stubLmStudio();
    const live = (await probeHostPort({ host: "127.0.0.1", port: 1234 }, 500, undefined, "local"))!;
    return Object.fromEntries(
      (await discoverModels(live, "lmstudio", "127.0.0.1:1234", config)).map((m) => [m.id, m]),
    );
  }

  it("uses loaded_context_length for a loaded model, as an exact value", async () => {
    const m = (await models())["loaded-llm"]!;
    assert.equal(m.contextWindow, 50176);
    assert.equal(m.contextSource, "native-api");
  });

  it("does not claim the 1M training maximum for models that are not loaded", async () => {
    const m = (await models())["unloaded-llm"]!;
    assert.equal(m.contextWindow, config.defaultContextWindow);
    assert.equal(m.contextSource, "estimated");
  });

  it("flags vision models and drops embedding models", async () => {
    const all = await models();
    assert.equal(all["vision-llm"]!.vision, true);
    assert.equal(all["loaded-llm"]!.vision, false);
    assert.equal(all["text-embedding-test"], undefined);
  });

  it("follows a reload with a different context size", async () => {
    const v0 = fixture("lmstudio-v0-models.json") as { data: Array<Record<string, unknown>> };
    v0.data.find((m) => m.id === "loaded-llm")!.loaded_context_length = 8192;
    stubLmStudio({ "/api/v0/models": v0 });
    const live = (await probeHostPort({ host: "127.0.0.1", port: 1234 }, 500, undefined, "local"))!;
    const m = (await discoverModels(live, "lmstudio", "127.0.0.1:1234", config)).find((x) => x.id === "loaded-llm")!;
    assert.equal(m.contextWindow, 8192);
  });
});
