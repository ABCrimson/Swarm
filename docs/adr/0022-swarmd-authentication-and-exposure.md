# ADR-0022: `swarmd` authentication and network exposure

- **Status:** Accepted
- **Date:** 2026-08-15 (hardened 2026-09-23; plaintext exposure classes 2026-11-04)

## Context

`swarmd` exposes a remote shell: `spawn_worker` and `worker_input` start processes and write to their
stdin as the daemon's user. WebSocket upgrades are exempt from CORS, so any web page open in the
operator's browser could otherwise reach a localhost daemon, and DNS rebinding can reach it from off
the machine. A fresh install pointed at `0.0.0.0` unattended must not be possible. The WebSocket is
plain `ws://`, so a wildcard bind with the token handed its shell-capable token to any peer that could
reach the port.

## Decision

- **A bearer token and no unauthenticated mode.** 256 bits from `getrandom`, hex-encoded (64
  characters), persisted at `<data_dir>/daemon-token`, compared in constant time (`subtle`). It is
  minted into a private temporary file (`0600` on Unix; on Windows the DACL is reduced to the current
  user's SID) and linked into place without clobbering, so no reader sees a partial or world-readable
  token and two racing first runs converge. Only exactly 64 hex characters load; a malformed file is an
  error and is never overwritten. Permissions are re-applied on every load; failure is fatal when
  binding a non-loopback address and a warning on loopback.
- **A non-loopback gate.** `--bind` to a non-loopback address is refused unless a valid token file
  already exists, so the first run of a fresh install is always loopback, where the token is minted
  and the connect URL printed. The existence check and the mint are separate functions and must run in
  that order: minting first would let a refused run create the file that lets an identical second run
  through. A two-process integration test drives that bypass.
- **A plaintext exposure class for every connection, judged by both of its ends** (`classify(remote,
  local)` in `crates/swarmd/src/exposure.rs`). Loopback (both ends loopback) is always served. Private
  LAN (both ends loopback or private IPv4, RFC 1918 or `100.64.0.0/10`, plain or IPv4-mapped, at least
  one not loopback) is served only with `--allow-plaintext-lan`. Public (any other address, every
  native IPv6 address but `::1`, or a local end the OS could not report) is never served. Both ends
  count: a public peer on a private interface came through a port forward, and a private peer on a
  public interface means that interface faces the internet. `100.64.0.0/10` is carrier-grade NAT
  space that IPv4 tailnet addresses share with carriers and other VPNs, so it is private space, never
  proof of a tailnet. The gate runs in the request layer before the `Host`/`Origin` check and again in
  the `/ws` upgrade before it takes a handshake slot; a refusal is a `403` naming what the connection
  would need. A concrete `--bind` that no connection could be served on exits `1` at startup; a
  wildcard bind is judged per connection. The non-loopback token gate above stays.
- **A `Host`/`Origin` allow-list on every request**, `--serve-ui` routes included. A `Host` (and an
  `Origin`, when sent) must name the concrete local address the connection arrived on as an IP literal
  with the same port, a loopback spelling when the connection arrived on loopback, or an operator
  `--allow-host NAME[:PORT]` entry for reverse proxies and MagicDNS names. IPv6 is handled
  bracket-aware.
- **A 5 s handshake deadline for every connection**, including one that pre-authenticated with an
  `Authorization: Bearer` header: a socket that never sends `hello` is closed. A wrong token closes
  with `4401`, a protocol violation with `1008`.
- **Admission pools.** Authenticated connections (32) and pre-authentication handshakes (16) are
  separate semaphores, so unauthenticated sockets cannot occupy a client's slot, and one client
  address (an IPv6 client by its `/64`) holds at most 4 handshakes. Loopback peers have no per-address
  share, because over `ssh -L` or behind a local reverse proxy every client arrives from loopback. A
  valid Bearer header takes the connection slot at upgrade. Messages and frames are capped at 2 MiB
  from the first byte.
- **The token appears in the connect URL only in the fragment** (`http://host:port/#t=...`), which is
  never sent to the server or logged by a proxy, and is printed only on a terminal; `swarmd
  connect-url` prints it on demand.
- **`--serve-ui` responses** carry a strict CSP (`default-src 'self'; script-src 'self'; style-src
  'self'; ... frame-ancestors 'none'`), `nosniff`, no-referrer and cross-origin isolation headers;
  paths with a hidden segment are 404.
- `ClientFrame`'s `Debug` output never prints the token or an rpc's arguments.

## Consequences

- The token is the only thing between an authenticated client and shell access as the daemon's user.
  Treat it like an SSH private key: never commit it, never paste it into a chat.
- A local process, or through a proxy an unauthenticated remote one, can keep the handshake pool full
  of idle sockets and hold off browser clients; clients that can send a Bearer header are not affected.
- There are no scoped sessions or per-method grants; `RemotePolicy` is the whole authorisation model.
- A LAN outside RFC 1918 and `100.64.0.0/10`, and a tailnet's IPv6 addresses, are refused even with
  `--allow-plaintext-lan`; an SSH tunnel or a TLS proxy on the same machine is loopback and needs no
  flag. The gate decides what `swarmd` serves, not what can reach the port: it is not a firewall.

See [Runtime Modes](../architecture.md#runtime-modes) and [daemon.md](../daemon.md).
