# 23496950 — the remote listener is a SEPARATE server; the loopback listener stays plain HTTP on PORT

Card `23496950` (from Code Reviewer findings B3/B5, confirmed by real repro: `bindHost:"0.0.0.0"` ⇒ every remote request 403s on the Host check; a specific-IP bind drops `127.0.0.1`; TLS made the whole app HTTPS). Supersedes the "https is a `Fastify()` construction option" mechanism of `6bc02f50` — its "resolve before construction" rule no longer applies because Fastify is now always plain.

## Decision

- `app.server` (Fastify) listens on `127.0.0.1:PORT`, **plain HTTP, in every configuration**. Every in-host consumer hardcodes `http://127.0.0.1:<PORT>` (the `loom` CLI probes, each session's MCP config in `pty/host.ts`, `assets/hook-relay.mjs`, `oauthRedirectUri`, the codescape probes) and none of them needs to change.
- The remote listener (`gateway/remote-listener.ts`) is a separately created `https`/`http` server on its own port (`remoteAccess.port`, default PORT+1, must differ from PORT). Requests go through `app.routing` so every onRequest hook still runs; upgrades are forwarded to `app.server` because `@fastify/websocket` listens for upgrades on `app.server` only.
- The remote server sets its OWN explicit, non-zero slow-loris limits (`REMOTE_SERVER_TIMEOUTS`: headers 10s, request 30s, keep-alive 5s, socket inactivity 60s, checked every 5s) and does NOT copy `app.server`'s: Fastify leaves `requestTimeout` at 0 and `keepAliveTimeout` at 72s, which would make this pre-auth, internet-facing listener weaker than plain Node (300s / 5s) — a stranger could announce a large Content-Length and hold the socket. Only `maxRequestsPerSocket` and the `clientError` listeners are shared. Loopback keeps Fastify's settings. Proven behaviourally in `test/remote-listener-real.mjs` (S), with a control that goes RED when the limits are disabled.
- TLS is loaded by the remote listener; `httpsActive` is that load, not a file-existence guess. A non-tailnet bind whose TLS did not load never opens (and is never opened as plain HTTP).
- Host allowlist: `bindHost` (unless a wildcard) plus `remoteAccess.allowedHosts`; REQUIRED for a wildcard bind. Exact, case-insensitive, no wildcards/suffixes; `0.0.0.0`, `::` and loopback are rejected as entries and `Host: 0.0.0.0` no longer passes.
- `Origin` is PEER-scoped: a loopback peer keeps the loopback-only rule; only a non-loopback peer may present a remote Origin, and it must equal the FULL origin (scheme + allowed host + the remote listener's port). Otherwise another local web service at `http://<allowedHost>:8080` viewed in a browser on the daemon host could read loopback-exempt reads such as `/ws/fleet`.
- Host entries (`bindHost` and `allowedHosts`) are matched in canonical form (`canonicalHost`, the shape the URL parser gives a request's Host), so `2001:db8:0:0:0:0:0:1` matches a client that sent `[2001:db8::1]`. A hostname-shaped entry the URL parser would reinterpret as an IPv4 (`0x7f.0.0.1`, `2130706433`, and zero-padded `192.168.001.050`, which is read as OCTAL, i.e. 192.168.1.40) is REJECTED, and the loopback/wildcard forbid-list runs on the canonical form (so `::0:1`, `::ffff:7f00:1` are caught).
- `remoteAccess.port` and `allowedHosts` are EXPOSED on the LOOM_DEV Platform Lead's read-only `platform_config_get` (same class as `bindHost`: a port number and hostnames — no credential, no host path); `tls` paths stay redacted. `test/platform-config-redaction-drift.mjs` pins the `remoteAccess` sub-keys so the next addition forces the same decision.
- Existing defect fixed on the way: with `enabled` + a valid cert + NO gateway token the daemon used to build an HTTPS app and then "fall back" to `127.0.0.1` — over TLS — breaking every agent. Loopback is now plain regardless.

## Do not

- Do not fold TLS back into `Fastify({ https })`, or make the loopback listener anything but plain HTTP on PORT.
- Do not copy `app.server`'s timeouts onto the remote server, or set a remote limit to 0 — and do not weaken the values without re-running the (S) scenario.
- Do not route a remote request around `app.routing`, and do not drop the `upgrade` forwarder.
- Do not match `0.0.0.0`/`::` in the Host allowlist, add wildcard/suffix matching, or accept a remote `Origin` from a loopback peer.
- Do not make `allowedHosts`/`port` agent-writable or add them to a project-config schema.
