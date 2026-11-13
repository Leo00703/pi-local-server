import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CACHE_VERSION } from "../core/config.js";
import extension from "../extensions/pi-local-server/index.js";

const tailscaleStatus = readFileSync(new URL("./fixtures/tailscale-status.json", import.meta.url), "utf8");
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const cachedLan = {
  server: {
    type: "llamacpp",
    label: "llama.cpp",
    host: "192.168.1.50",
    port: 8080,
    origin: "http://192.168.1.50:8080",
    baseUrl: "http://192.168.1.50:8080/v1",
    latencyMs: 1,
    source: "lan",
  },
  models: [{ id: "m", contextWindow: 8192, contextSource: "server", maxTokens: 4096, reasoning: false }],
  seenAt: Date.now() - 24 * 60 * 60 * 1000,
};

describe("Pi extension: remembered server found again at another address", () => {
  it("drops the remembered LAN copy once the same machine answers over Tailscale", async () => {
    process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-cache-"));
    writeFileSync(
      join(process.env.PI_CODING_AGENT_DIR, "pi-local-server-cache.json"),
      JSON.stringify({ version: CACHE_VERSION, savedAt: Date.now(), entries: [cachedLan] }),
    );
    // Only the Tailscale address answers (same model as the remembered LAN entry).
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.host !== "100.64.0.2:8080") throw new TypeError("connection refused");
      const routes: Record<string, unknown> = {
        "/v1/models": { data: [{ id: "m" }] },
        "/props": { default_generation_settings: { n_ctx: 8192 }, build_info: "b1" },
      };
      return url.pathname in routes
        ? new Response(JSON.stringify(routes[url.pathname]), { status: 200 })
        : new Response("{}", { status: 404 });
    }) as typeof fetch;

    const registered: string[] = [];
    const unregistered: string[] = [];
    const handlers = new Map<string, Array<(e: unknown, c: unknown) => Promise<void> | void>>();
    await extension({
      registerProvider: (id: string) => registered.push(id),
      unregisterProvider: (id: string) => unregistered.push(id),
      registerCommand: () => {},
      exec: async (_cmd: string, args: string[]) => ({ stdout: args[0] === "status" ? tailscaleStatus : "" }),
      on: (name: string, h: (e: unknown, c: unknown) => Promise<void> | void) => {
        handlers.set(name, [...(handlers.get(name) ?? []), h]);
        return () => {};
      },
    } as never);

    // Startup restored the remembered LAN entry.
    assert.ok(registered.includes("local-llamacpp-192-168-1-50-8080"));

    const ctx = { hasUI: false, ui: { notify: () => {}, setStatus: () => {} }, signal: undefined };
    for (const h of handlers.get("session_start") ?? []) await h({}, ctx);

    assert.ok(registered.includes("local-llamacpp-100-64-0-2-8080"));
    assert.deepEqual(unregistered, ["local-llamacpp-192-168-1-50-8080"]);
  });
});
