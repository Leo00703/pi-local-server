import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  getTailscalePeers,
  parseTailscalePeers,
  tailscaleCliCandidates,
} from "../core/discovery.js";

const status = readFileSync(new URL("./fixtures/tailscale-status.json", import.meta.url), "utf8");

describe("tailscale status parsing", () => {
  it("yields exactly one address per online peer (no DNS+IP duplicates)", () => {
    const peers = parseTailscalePeers(status);
    assert.deepEqual(peers, [
      { address: "100.64.0.2", name: "DESKTOP", lanAddress: "192.168.1.50" },
      { address: "nas.example.ts.net", name: "nas" },
    ]);
  });

  it("skips offline peers, the node itself and peers without any address", () => {
    const addresses = parseTailscalePeers(status).map((p) => p.address);
    assert.ok(!addresses.includes("100.64.0.3"));
    assert.ok(!addresses.includes("100.64.0.1"));
    assert.equal(addresses.length, 2);
  });

  it("returns [] on garbage", () => {
    assert.deepEqual(parseTailscalePeers("not json"), []);
  });
});

describe("tailscale CLI lookup", () => {
  it("knows the macOS app bundle, Windows and Linux locations", () => {
    assert.ok(tailscaleCliCandidates("darwin").includes("/Applications/Tailscale.app/Contents/MacOS/Tailscale"));
    assert.ok(tailscaleCliCandidates("win32").some((c) => c.endsWith("Tailscale\\tailscale.exe")));
    assert.ok(tailscaleCliCandidates("linux").includes("/usr/bin/tailscale"));
    for (const p of ["darwin", "win32", "linux"] as const) assert.equal(tailscaleCliCandidates(p)[0], "tailscale");
  });

  it("falls through missing binaries to the one that works", async () => {
    const tried: string[] = [];
    const peers = await getTailscalePeers(async (cmd) => {
      tried.push(cmd);
      if (cmd.includes("Tailscale.app")) return { stdout: status };
      throw new Error("ENOENT");
    }, "darwin");
    assert.equal(tried[0], "tailscale");
    assert.equal(peers.length, 2);
  });
});
