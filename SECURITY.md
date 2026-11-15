# Security policy

## Supported versions

Only the latest release of each package receives fixes.

| Package | Supported |
|---|---|
| `pi-local-server` | latest |
| `opencode-local-server` | latest |

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private reporting instead: go to the [Security tab](https://github.com/Leo00703/pi-local-server/security/advisories/new) of this repository and choose **Report a vulnerability**. You will get a reply within a few days, and we will agree on a fix and disclosure date together.

Useful details: affected version, what an attacker needs (same LAN? a Tailscale peer? a malicious server answer?), and a minimal way to reproduce it.

## What is in scope

This tool probes the network on its own, so the interesting questions are:

- Can it be made to contact a **public** or otherwise unintended host without the user listing it?
- Can an **API key** reach a host other than the one it was configured for?
- Can a **malicious server answer** (model names, metadata, huge or malformed JSON) crash the host program, execute code, or write outside the cache file?
- Can the **cache file** be abused (path handling, injection of providers)?

## Design guarantees

These are intended behaviour; a violation is a security bug:

- Automatic discovery only probes private addresses: loopback, RFC 1918, link-local, Tailscale `100.64.0.0/10`, MagicDNS, `.local` and bare LAN names. A public host is contacted only if the user lists it in `PI_LOCAL_SERVER_HOSTS`.
- A real API key is sent only to loopback and to hosts the user configured. Every other discovered machine only ever sees the placeholder key `local`.
- Redirects are never followed.
- The cache stores addresses and model metadata, never keys.
- Connections are plain `http://` to local servers; there is no telemetry and no outbound call to any service operated by the author.
