# opencode-local-server

[![npm](https://img.shields.io/npm/v/opencode-local-server?color=cb3837)](https://www.npmjs.com/package/opencode-local-server)
[![CI](https://github.com/Leo00703/pi-local-server/actions/workflows/ci.yml/badge.svg)](https://github.com/Leo00703/pi-local-server/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/Leo00703/pi-local-server)](https://github.com/Leo00703/pi-local-server/blob/main/LICENSE)

OpenCode plugin that finds the local LLM servers you already run — on this machine, on your LAN and on your Tailscale network — and adds them to OpenCode as providers, with the **real context window** of every model. No `opencode.json` editing per machine.

Supported: llama.cpp (including router mode / the Llama-macOS app), LM Studio, Strata, Ollama, vLLM, SGLang, Jan, llama-swap and other OpenAI-compatible servers. Shares its discovery code with [`pi-local-server`](https://github.com/Leo00703/pi-local-server#readme), the same extension for Pi.

## Which OpenCode versions

Works with both plugin generations: OpenCode **1.x** (config hook, read when OpenCode loads its config) and **2.x** (the current Desktop builds; `setup` + `provider.transform`). On 2.x the providers are also refreshed every minute while OpenCode runs, so a context window follows a server that was restarted with another size, and servers started after OpenCode show up within a few minutes. Tested with 1.19.5 and 2.2.6, on macOS and Windows 11.

## Install

Add the plugin once per device, in `~/.config/opencode/opencode.jsonc` (Windows: `%USERPROFILE%\.config\opencode\opencode.jsonc`):

```jsonc
{
  "plugin": ["opencode-local-server"]
}
```

Nothing else. Every time OpenCode loads its config the plugin looks for servers and registers one provider per server, named like `Strata (DESKTOP 100.64.0.2:8080)`; pick the model from the model list.

Alternatively (and this is the simplest, it needs no config edit), copy the built `dist/index.js` to `~/.config/opencode/plugins/local-server.js` (Windows: `%USERPROFILE%\.config\opencode\plugins\local-server.js`); OpenCode loads `.js` files from that folder by itself. Restart OpenCode afterwards. On 2.x the config key is `plugins` instead of `plugin` (per the OpenCode docs; not verified here), the folder approach works on both.

## What it does

- **Context is read from the server, every time.** llama.cpp: `--ctx-size` / `/props` (router mode and single model), Strata: `/props`, LM Studio: the context the model is loaded with. Never the model's training maximum unless nothing else exists. The model's `limit.context` and `limit.output` come from it, so compaction and output limits match the server.
- **Servers that are off are not shown for ever.** The plugin remembers the servers it found; one that has not answered for 7 days is forgotten, and a machine remembered at two addresses is listed once.
- **Fast start.** After the first run, only this machine, Tailscale peers and the servers seen before are checked before OpenCode starts (about 1-2 s); the LAN sweep runs in the background and updates the cache.
- **One provider per machine.** A machine reachable over both LAN and Tailscale is registered once, by its tailnet address.
- **Safe by default.** Only private addresses are probed, redirects are never followed, and a real API key is only sent to a `host:port` you gave it for.
- **If the server is restarted with a smaller context while OpenCode is running**: on 2.x the limits are refreshed within a minute; on 1.x requests are limited to what fits and a warning is logged, restart OpenCode to refresh the limits.
- It never replaces a provider you defined yourself, or one listed in `disabled_providers`.

## Options

```jsonc
{
  "plugin": [
    ["opencode-local-server", {
      "hosts": ["my-pc"],                       // always probed (names or IPs)
      "apiKeys": { "100.64.0.2:8080": "sk-..." }, // key for one host:port (only needed if the server enforces one)
      "contextOverrides": { "my-model": 32768 },  // force a context for a model id
      "disable": ["ollama"],                     // skip engine types
      "lan": true,                               // LAN (ARP) scan
      "tailscale": true                          // Tailscale peers
    }]
  ]
}
```

The `PI_LOCAL_SERVER_*` environment variables described in the main README work here too. Set `OPENCODE_LOCAL_SERVER_DEBUG=1` to print scan diagnostics to stderr.

## Servers on another machine

Servers listen on `127.0.0.1` by default and must be reachable from the other device: start llama.cpp with `--host 0.0.0.0`, enable "serve on local network" in LM Studio, start Strata with `--host 0.0.0.0` (see the main README), and allow the port in the firewall for Tailscale (`100.64.0.0/10`).

## Build

```bash
npm run build:opencode   # bundles opencode/src + ../core into opencode/dist/index.js
```
