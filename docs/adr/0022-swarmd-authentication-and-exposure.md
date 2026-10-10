# ADR-0022: `swarmd` authentication and network exposure

- **Status:** Accepted
- **Date:** 2026-08-15 (hardened 2026-09-23)

## Context

`swarmd` exposes a remote shell: `spawn_worker` and `worker_input` start processes and write to their
stdin as the daemon's user. WebSocket upgrades are exempt from CORS, so any web page open in the
operator's browser could otherwise reach a localhost daemon, and DNS rebinding can reach it from off
the machine. A fresh install pointed at `0.0.0.0` unattended must not be possible.

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

See [Runtime Modes](../architecture.md#runtime-modes) and [daemon.md](../daemon.md).
