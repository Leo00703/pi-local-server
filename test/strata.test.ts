import { afterEach, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { loadConfig } from "../core/config.js";
import { discoverModels, fingerprint } from "../core/detectors.js";
import { probeHostPort } from "../core/discovery.js";

// Real answers captured from Strata 0.1.57 on Windows (GET /v1/models, GET /props);
// model_path removed and chat_template shortened.
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;
const strataModels = fixture("strata-models.json");
const strataProps = fixture("strata-props.json");
const MODEL = "strata-model";
const CTX = 204800;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stub(routes: Record<string, { status?: number; body: unknown }>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    const r = routes[path];
    return r
      ? new Response(JSON.stringify(r.body), { status: r.status ?? 200 })
      : new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }) as typeof fetch;
}

const config = loadConfig();
const probe = () => probeHostPort({ host: "100.64.0.2", port: 8080 }, 500, undefined, "local");

describe("Strata", () => {
  it("is told apart from llama.cpp by its build_info", async () => {
    stub({ "/v1/models": { body: strataModels }, "/props": { body: strataProps } });
    const live = (await probe())!;
    assert.deepEqual(fingerprint(live), { type: "strata", label: "Strata" });
  });

  it("takes the context the engine reports, plus vision and thinking", async () => {
    stub({ "/v1/models": { body: strataModels }, "/props": { body: strataProps } });
    const live = (await probe())!;
    const [m] = await discoverModels(live, "strata", "100.64.0.2:8080", config);
    assert.equal(m!.id, MODEL);
    assert.equal(m!.contextWindow, CTX);
    assert.equal(m!.contextSource, "server");
    assert.equal(m!.vision, true);
    assert.equal(m!.reasoning, true);
  });

  it("still finds the model when an API key hides /v1/models, via /props model_alias", async () => {
    stub({ "/v1/models": { status: 401, body: { error: "unauthorized" } }, "/props": { body: strataProps } });
    const live = (await probe())!;
    assert.equal(fingerprint(live).type, "strata");
    const [m] = await discoverModels(live, "strata", "100.64.0.2:8080", config);
    assert.equal(m!.id, MODEL);
    assert.equal(m!.contextWindow, CTX);
  });

  it("follows a restart with a smaller context", async () => {
    stub({
      "/v1/models": { body: strataModels },
      "/props": { body: { ...strataProps, default_generation_settings: { n_ctx: 32768 } } },
    });
    const live = (await probe())!;
    const [m] = await discoverModels(live, "strata", "100.64.0.2:8080", config);
    assert.equal(m!.contextWindow, 32768);
  });
});
