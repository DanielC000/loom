# 1d882a8c — an owner opt-in to plain http for a private/LAN connection host

Owner decision 2026-11-06 (request bf39ab98, option A). The first consumer is the owner's Plex on a LAN address, which speaks http only. This RELAXES an egress control (a secret now travels unencrypted), so the relaxation is narrow, per connection, owner-only and re-checked at every request.

## Surface

- A new column `connections.allow_plain_http INTEGER NOT NULL DEFAULT 0`, added only through `CONNECTION_ADDED_COLUMNS` / `migrateConnections()` (no index on it). Every legacy row backfills to 0 = https only. It is decoded fail-closed: only an explicit `1` enables plain http.
- `ConnectionMetadata.allowPlainHttp` (absent when off). Settable on `POST /api/connections` and `PATCH /api/connections/:id` for api-key / bearer only (an oauth2 or ssh row refuses it, and a tampered oauth2 row's flag is ignored at request time). These routes are Tier 0 (absent from `TIER_1_ROUTES` / `TIER_2_ROUTES`), so a remote or gateway-token peer gets 403 on both; there is no MCP tool that reads or writes the flag.
- The scheme is the flag, never text in `host`. `host` stays `host[:port]` and `validateConnectionHost(host, "http")` still refuses a scheme in it, `:80` (the URL parser drops a default port, so it could never round-trip) and a public IP literal. `hostRoundTrips(host, scheme)` in `hostForm.ts` is the ONE round-trip helper for both schemes; `httpsHostRoundTrips` is a wrapper.
- Settings → Connections: a "Allow plain HTTP (LAN only)" checkbox with the warning, in the create form and the edit form (api-key / bearer only), and an "HTTP (LAN)" badge on the row. Existing `busy` tone only.

## Request-time rules (`connections/lanHttp.ts`, called from `connections/request.ts`)

- What a configured host may resolve to depends on how it is written. An IP literal: RFC 1918, fc00::/7 ULA, loopback or link-local, as written. Exactly `localhost`: every resolved address must be loopback. Any other name (including `.local`): every resolved address must be RFC 1918 or ULA. A name that resolves to loopback or link-local is REFUSED, and one public address among several refuses the lot.
- The host is resolved ONCE, and the request is pinned to the checked address: `createPinnedHttpFetch` is a `fetch`-shaped adapter over `node:http` that dials that IP literal (the URL's authority is ignored; `Host` is the configured host), with `agent: false`. It plugs in through `boundedFetch`'s `fetchImpl`, so the manual-redirect, timeout, streamed byte cap and URL-free error guarantees (decision 25c93b6f) are the shared ones.
- A redirect is never followed (to another host or to https): a 3xx comes back as `{status, location}` data exactly as before. The refusal text is fixed and never echoes the host, the address or the secret.
- The check runs after the rate limit (a caller cannot drive unbounded DNS with refused calls) and before the secret is decrypted.

## The owner's existing Plex row (b169800a)

It stores `http://192.168.178.136:32400` in `host`. It is NOT migrated: it is already flagged `invalidHost`, and rewriting a credential row's scheme and turning on an egress relaxation would be a trust change made for the owner. The owner's edit (Settings → Connections → Plex → Edit): set Host to `192.168.178.136:32400`, tick "Allow plain HTTP (LAN only)", Save. Plex still needs card 0683ac4d (a per-connection header name) because an api-key connection sends `X-API-Key`, not `X-Plex-Token`.

## Do not

- Do not accept loopback or link-local for a hostname that merely RESOLVES there; only an IP literal written that way (or exactly `localhost` for loopback) may. That closes rebinding a LAN name onto the daemon's own loopback port or 169.254.169.254.
- Do not resolve the host a second time between the check and the connect, and do not dial the URL's authority in the plain-http path; dial the checked address.
- Do not follow a redirect on this path, and do not let `treatRedirectAsError: false` spread beyond `authenticated_request`.
- Do not parse the scheme out of `host`, and do not add a second host round-trip rule; extend `hostRoundTrips`.
- Do not add an MCP tool, a remote-tier route or any agent-writable path that sets `allowPlainHttp`; do not honour the flag for oauth2 or ssh.
- Do not silently migrate a stored row's scheme or flag.
