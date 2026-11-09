import { afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../extensions/pi-local-server/index.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;
interface Registered {
  id: string;
  config: { models: Array<{ id: string; contextWindow: number; maxTokens: number }> };
}

/** A llama.cpp server on 127.0.0.1:8080 whose context size the test can change. */
const server = { nCtx: 8192, up: true };
function stubServer(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (!server.up || url.host !== "127.0.0.1:8080") throw new TypeError("connection refused");
    const routes: Record<string, unknown> = {
      "/v1/models": { data: [{ id: "m", object: "model" }] },
      "/props": { default_generation_settings: { n_ctx: server.nCtx }, build_info: "b1" },
    };
    if (url.pathname in routes) return new Response(JSON.stringify(routes[url.pathname]), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

describe("dynamic context window", () => {
  const registered: Registered[] = [];
  const handlers = new Map<string, Handler[]>();
  const notes: string[] = [];
  const ctx = {
    hasUI: true,
    ui: { notify: (m: string) => notes.push(m), setStatus: () => {} },
    model: { provider: "local-llamacpp-127-0-0-1-8080", id: "m" },
  };
  const fire = async (name: string, event: unknown = {}) => {
    for (const h of handlers.get(name) ?? []) await h(event, ctx);
  };
  const latest = () => registered.filter((r) => r.id === ctx.model.provider).at(-1)!.config.models[0]!;

  // The file-level afterEach restores the real fetch; each test needs the stub back.
  beforeEach(stubServer);

  before(async () => {
    process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-local-server-test-"));
    server.nCtx = 8192;
    stubServer();
    await extension({
      registerProvider: (id: string, config: Registered["config"]) => registered.push({ id, config }),
      registerCommand: () => {},
      exec: async () => ({ stdout: "" }),
      on: (name: string, h: Handler) => {
        handlers.set(name, [...(handlers.get(name) ?? []), h]);
        return () => {};
      },
    } as never);
  });

  it("registers the context the server runs with at startup", () => {
    assert.equal(latest().contextWindow, 8192);
    assert.equal(latest().maxTokens, 4096);
  });

  it("picks up a restart with a different context before the next agent run", async () => {
    server.nCtx = 4096;
    await fire("before_agent_start");
    assert.equal(latest().contextWindow, 4096);
    assert.equal(latest().maxTokens, 2048);
    assert.ok(notes.some((n) => n.includes("8192") && n.includes("4096")), notes.join("|"));
  });

  it("does not hammer the server: checks are throttled per turn", async () => {
    server.nCtx = 2048;
    await fire("turn_start");
    assert.equal(latest().contextWindow, 4096);
  });

  it("re-checks immediately when the user selects the model", async () => {
    await fire("model_select", { model: ctx.model });
    assert.equal(latest().contextWindow, 2048);
  });

  it("keeps the last known models when the server is unreachable", async () => {
    server.up = false;
    await fire("model_select", { model: ctx.model });
    assert.equal(latest().contextWindow, 2048);
  });
});
