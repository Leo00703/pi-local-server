import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { apiKeyFor, loadConfig } from "../core/config.js";
import { isPrivateHost, parseArpIps, probeMany, probeV1Models } from "../core/discovery.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const base = loadConfig();
const cfg = {
  ...base,
  apiKey: "sk-global",
  extraHosts: ["desktop"],
  perServerApiKeys: { "100.64.0.2:8080": "sk-strata" },
};

describe("API key scoping", () => {
  it("sends the exact per-server key only to that host:port", () => {
    assert.equal(apiKeyFor("100.64.0.2", 8080, cfg), "sk-strata");
    assert.equal(apiKeyFor("100.64.0.2", 1234, cfg), "local");
  });

  it("sends the global key only to loopback and explicitly listed hosts", () => {
    assert.equal(apiKeyFor("127.0.0.1", 8080, cfg), "sk-global");
    assert.equal(apiKeyFor("localhost", 1234, cfg), "sk-global");
    assert.equal(apiKeyFor("desktop", 8080, cfg), "sk-global");
  });

  it("never sends a real key to an auto-discovered host", () => {
    assert.equal(apiKeyFor("192.168.1.77", 8080, cfg), "local");
    assert.equal(apiKeyFor("100.64.0.9", 8080, cfg), "local");
  });
});

describe("private-address policy", () => {
  it("accepts loopback, LAN, Tailscale and local names", () => {
    for (const h of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.12", "100.64.0.2", "desktop", "desktop.example.ts.net", "nas.local", "169.254.1.1"]) {
      assert.equal(isPrivateHost(h), true, h);
    }
  });

  it("rejects public addresses", () => {
    for (const h of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "100.63.0.1", "example.com", "93.184.216.34"]) {
      assert.equal(isPrivateHost(h), false, h);
    }
  });

  it("probeMany skips public hosts unless the user listed them", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(new URL(String(input)).host);
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    await probeMany(
      [{ host: "8.8.8.8", port: 8080 }, { host: "desktop", port: 8080 }, { host: "example.org", port: 8080 }],
      { ...base, extraHosts: ["example.org"] },
    );
    assert.ok(!seen.some((h) => h.startsWith("8.8.8.8")));
    assert.ok(seen.some((h) => h.startsWith("desktop")));
    assert.ok(seen.some((h) => h.startsWith("example.org")));
  });

  it("ignores the Windows 'Interface:' headers, which are this PC's own addresses", () => {
    const windows = [
      "Interface: 192.168.1.50 --- 0x5",
      "  Internet Address      Physical Address      Type",
      "  192.168.1.1           aa-bb-cc-dd-ee-01     dynamic",
      "  192.168.1.77          aa-bb-cc-dd-ee-02     dynamic",
      "  224.0.0.22            01-00-5e-00-00-16     static",
      "  255.255.255.255       ff-ff-ff-ff-ff-ff     static",
      "Interface: 100.64.0.1 --- 0x9",
      "  100.64.0.2            aa-bb-cc-dd-ee-03     dynamic",
    ].join("\r\n");
    assert.deepEqual(parseArpIps(windows), ["192.168.1.1", "192.168.1.77", "100.64.0.2"]);
  });

  it("drops multicast addresses from the ARP table", () => {
    const out = parseArpIps("? (192.168.1.1) at aa:bb on en0\n? (224.0.0.251) at 1:0:5e on en0\n? (239.255.255.250) at 1:0:5e on en0\n? (192.168.1.255) at ff on en0");
    assert.deepEqual(out, ["192.168.1.1"]);
  });
});

describe("probe hygiene", () => {
  it("never follows redirects", async () => {
    let init: RequestInit | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, i?: RequestInit) => {
      init = i;
      return new Response("{}", { status: 302, headers: { location: "http://evil.example/" } });
    }) as typeof fetch;
    const res = await probeV1Models("http://192.168.1.5:8080", 500, undefined, "sk-secret");
    assert.equal(res.ok, false);
    assert.equal(init?.redirect, "manual");
  });
});
