# Security model

pi-local-server probes your network on its own, so it is deliberately conservative.

- **Private addresses only.** Automatic discovery only contacts loopback, RFC 1918 ranges, link-local, the Tailscale range `100.64.0.0/10`, MagicDNS names, `.local` and bare LAN names. A public host is contacted only if you list it in `PI_LOCAL_SERVER_HOSTS`.
- **Keys stay where you put them.** A real API key is only sent to loopback and to hosts you configured (`PI_LOCAL_SERVER_API_KEY` for listed hosts, `PI_LOCAL_SERVER_API_KEYS` per server). Auto-discovered neighbours, such as other machines in the ARP table or other Tailscale peers, only ever see the placeholder `local`.
- **No redirects.** HTTP redirects are never followed, so a server cannot bounce a request (or a key) elsewhere.
- **Multicast is dropped** from the ARP sweep.
- **The cache holds no secrets.** It stores addresses and model metadata, never keys.
- **No telemetry.** The only network traffic is to your own local servers (and the `tailscale` / `arp` commands on your machine).
- **Plain HTTP.** Traffic to local servers is unencrypted; on a LAN, prefer Tailscale (end-to-end encrypted) for anything sensitive.

Found a problem? Please report it privately: see [SECURITY.md](../SECURITY.md).
