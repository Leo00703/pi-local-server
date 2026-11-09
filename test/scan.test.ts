import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig } from "../core/config.js";
import { scanAll, type FoundServer } from "../core/scan.js";

const tailscaleStatus = readFileSync(new URL("./fixtures/tailscale-status.json", import.meta.url), "utf8");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Hosts that answer as a single-model llama.cpp server on :8080; everything else refuses. */
function stubLlamaHosts(hosts: Record<string, number>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const nCtx = url.port === "8080" ? hosts[url.hostname] : undefined;
    if (nCtx === undefined) throw new TypeError("connection refused");
    const routes: Record<string, unknown> = {
      "/v1/models": { data: [{ id: "model-a" }] },
      "/props": { default_generation_settings: { n_ctx: nCtx }, build_info: "b1" },
    };
    return url.pathname in routes
      ? new Response(JSON.stringify(routes[url.pathname]), { status: 200 })
      : new Response("{}", { status: 404 });
  }) as typeof fetch;
}

const exec = async (cmd: string, args: string[]) => {
  if (cmd === "arp") {
    return { stdout: "? (192.168.1.50) at aa:bb on en0\n? (192.168.1.77) at cc:dd on en0\n? (224.0.0.251) at 01:00 on en0\n" };
  }
  if (args[0] === "status") return { stdout: tailscaleStatus };
  throw new Error("unexpected command");
};

const run = async (): Promise<FoundServer[]> => {
  const emitted: FoundServer[] = [];
  const { found } = await scanAll({
    config: { ...loadConfig({}), extraHosts: [] },
    exec,
    hostNames: new Map(),
    onFound: (f) => emitted.push(f),
  });
  assert.deepEqual([...found.keys()].sort(), emitted.map((f) => f.providerId).sort());
  return emitted;
};

describe("scanAll", () => {
  it("registers a machine once when it is reachable over both LAN and Tailscale", async () => {
    // 192.168.1.50 is the desktop's direct address (Tailscale CurAddr) = same machine as 100.64.0.2.
    stubLlamaHosts({ "192.168.1.50": 8192, "100.64.0.2": 8192 });
    const servers = await run();
    assert.deepEqual(servers.map((s) => s.server.host), ["100.64.0.2"]);
    assert.equal(servers[0]!.server.source, "tailscale");
    assert.equal(servers[0]!.server.hostName, "DESKTOP");
  });

  it("keeps a LAN-only machine that is not a Tailscale peer", async () => {
    stubLlamaHosts({ "192.168.1.50": 8192, "100.64.0.2": 8192, "192.168.1.77": 4096 });
    const servers = await run();
    const hosts = servers.map((s) => s.server.host).sort();
    assert.deepEqual(hosts, ["100.64.0.2", "192.168.1.77"]);
    assert.equal(servers.find((s) => s.server.host === "192.168.1.77")!.models[0]!.contextWindow, 4096);
  });

  it("still finds the tailnet server when arp hangs or fails", async () => {
    stubLlamaHosts({ "100.64.0.2": 32768 });
    const failing = async (cmd: string, args: string[]) => {
      if (cmd === "arp") throw new Error("arp: not permitted");
      return exec(cmd, args);
    };
    const { found } = await scanAll({ config: { ...loadConfig({}), extraHosts: [] }, exec: failing });
    assert.deepEqual([...found.values()].map((f) => f.server.host), ["100.64.0.2"]);
  });
});
