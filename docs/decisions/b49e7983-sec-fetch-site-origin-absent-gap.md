# b49e7983 — `Sec-Fetch-Site: cross-site` backstop for the Origin-absent fail-safe

## Narrative

The CSRF/DNS-rebind `onRequest` hook (`gateway/server.ts`) refuses a PRESENT non-loopback `Origin`, but
treats an ABSENT `Origin` as the fail-safe ALLOW path — deliberately, so non-browser clients (CLI,
Run-API-key, server-to-server callers) that send no `Origin` at all keep working. The gap: browsers also
omit `Origin` on a no-cors GET/HEAD subresource load (`<img src>`, `<script src>`,
`fetch(url,{mode:'no-cors'})`) and on some simple-content-type cross-site POST/redirect paths — so that
same fail-safe path is reachable by browser-originated cross-site traffic too, not only by genuine
non-browser clients.

Card 8f050b79 made this concrete: it serves attacker-influenced attachment HTML inside an iframe with
`sandbox="allow-scripts"` (no `allow-same-origin`), giving that document an OPAQUE origin. Per the Fetch
Metadata spec's "same site?" algorithm, an opaque origin is same-site to nothing, including the host that
served it — so every request that document fires carries `Sec-Fetch-Site: cross-site`, even though it is
hitting the very same loopback daemon that served it.

The fix adds one more check to the same hook, right after the existing Origin check: when `Origin` is
absent **and** the matched route (`req.routeOptions.url`) is under `/api/*` **and**
`req.headers['sec-fetch-site'] === "cross-site"` (exact, case-sensitive), refuse with the same 403 body.
Every other `Sec-Fetch-Site` value — `same-origin`, `same-site`, `none`, absent, or anything malformed —
is treated like absent: ALLOWED, same fail-safe direction as the Origin check it backstops.

The check is deliberately method-agnostic (not limited to GET/HEAD): a cross-site no-cors POST with a
simple content-type can also arrive with no `Origin` in some browsers' redirect paths, and there is no
cost to covering it too.

`same-site` is deliberately ALLOWED, not refused, even though it is a form of cross-origin access: this
file already treats ANY port on a loopback hostname as equally trusted (`isAllowedOrigin`/
`isAllowedHostname`, same file — "we match the loopback HOSTNAME, not a single bound-port pin,
deliberately... a loopback-port origin already implies local code execution"). Refusing `same-site` would
be inconsistent with that existing, deliberate policy. No current legitimate flow was found that would
even produce `same-site` on a loopback `/api/*` request today (the web UI's own client code — `api.ts`,
`gatewayCredential.ts`, `loopbackCredential.ts` — always issues relative-URL fetches, and the `pnpm web`
dev proxy forwards with `changeOrigin:true`, which rewrites `Host` but not `Origin`/`Sec-Fetch-Site`, so
the browser computes `Sec-Fetch-Site: same-origin` from the page's own perspective before the proxy ever
touches the request).

Scope is `/api/*` only — the card's own scope. `/internal/*`, `/oauth/callback`, `/ws/*`, `/mcp*`, and the
SPA shell (`/*`) are untouched: loading the SPA shell itself has no side effect regardless of how it was
reached, and `/oauth/callback` already has its own, narrower Origin exemption plus its single-use `state`
correlation as the real defense.

**Side-effect audit (this card's own DoD item 1):** `gateway/server.ts` registers 106 `GET` and 2 `HEAD`
routes under `/api/*` (108 total; counted via `grep -c 'app\.\(get\|head\)("/api/'` against this file,
2026-10-22 — recount it rather than trusting this figure if the route set has since changed), plus 6
non-`/api` `GET` routes (`/oauth/callback`, two `/internal/*` reads, and the three `/ws/*` websocket-upgrade
handlers) that this card's fix does not touch (scope is `/api/*` only — see above). Of all of these, one
has a real side effect reachable by a plain no-cors GET — `GET /api/tasks/:id` (server.ts ~4572-4591, the
write itself at ~4583) lazily backfills `mergedSha`/ship-state info via
`deps.db.setTaskMergedInfoNoTouch(...)` on a cache miss, a genuine DB write triggered purely by a GET.
Low blast radius (idempotent backfill of already-true derived data), but exactly the shape this card
worries about. `GET /oauth/callback` also performs a write (an OAuth token exchange) but is already a
deliberate, narrowly-scoped exception (see above) and is outside `/api/*` regardless. Every other
GET/HEAD route audited is read-only. Fixing the Origin-absent gap at this one gateway chokepoint closes
the exposure for all of these uniformly — no per-route handler change was needed. (`csrf-rebind.mjs`
cases (g1)-(g4) now repro this exact route with a real git-backed merged task: proving the backfill write
actually happens for an allowed request and genuinely does not happen — the row stays unchanged — for a
refused one.)

**Proxy-class remote requests bypass this hook entirely, by design, and that's fine:** the `onRequest`
hook's own `cls.kind === "remote" && cls.via === "proxy"` branch (server.ts, right above the Origin check)
returns before ever reaching the Origin/Sec-Fetch-Site checks — a request arriving via the trusted-proxy
listener never evaluates this backstop at all. That's safe because every `/api/*` route is Tier 1 under
the trust-tier wall registered right after this hook (`gateway/trust-tier.ts`, card 766f8b50): a remote
request must present a valid gateway token via `Authorization: Bearer`, and a browser's no-cors/
opaque-origin request can never attach a custom header — so the ambient-fail-safe gap this card closes for
the loopback-only Origin-absent path has no remote equivalent to begin with.

**Verified against a real browser (2026-10-22):** a real headless Chromium (`HeadlessChrome/155.0.0.0`)
against a bare `node:http` echo server on 127.0.0.1 (no Loom daemon involved) confirms the Fetch Metadata
claim above. A sandboxed child `<iframe sandbox="allow-scripts">` (no `allow-same-origin`, opaque origin)
hitting its own host: an `<img src>` GET and a `fetch(url,{mode:'no-cors'})` GET both send
`Sec-Fetch-Site: cross-site` with Origin ABSENT — the exact shape this fix targets. A sandboxed no-cors
POST instead sends `Sec-Fetch-Site: cross-site` with `Origin: "null"` (present, the literal string) —
already caught by the pre-existing Origin check, not this backstop (see `csrf-rebind.mjs` cases (i)/(j)).
A sandboxed `<form method=POST>` is blocked by the sandbox itself (no `allow-forms`) before any request
leaves the frame at all. The top-level (non-sandboxed) control sends `Sec-Fetch-Site: same-origin` on
every case, with Origin absent on GET and present (the real origin, never `"null"`) on POST. Full
measurement log: project memory `b49e7983-sec-fetch-headers-measured`.

**Product note:** any HTML attachment the inbox serves (card 8f050b79) that embeds a `/api/*` image
(`<img src="/api/...">` inside the sandboxed document) now gets a 403 for that image load, since the
sandboxed document's opaque origin makes every one of its requests `Sec-Fetch-Site: cross-site` with no
Origin. This is intended — no legitimate web-UI flow was found that relies on an untrusted HTML attachment
loading a live `/api/*` resource.

## Do not

- Do not refuse `Sec-Fetch-Site: same-site` on `/api/*` — this file already trusts any loopback port
  equally (see `isAllowedOrigin`/`isAllowedHostname`); refusing `same-site` would contradict that existing
  policy for no real security gain, since no legitimate flow produces it today anyway.
- Do not scope this check by method (GET/HEAD only) — a cross-site no-cors POST with a simple
  content-type can also arrive with no `Origin`, and the check costs nothing extra to make method-agnostic.
- Do not widen the scope beyond `/api/*` without re-auditing `/internal/*`, `/oauth/callback`, `/ws/*`,
  `/mcp*`, and the SPA shell for routes that might legitimately need a different `Sec-Fetch-Site` posture
  (e.g. the OAuth callback's own narrower Origin exemption).
- Do not treat a malformed/unrecognised `Sec-Fetch-Site` value as a reason to refuse — match the one
  refuse-value exactly and case-sensitively; everything else, including a value that isn't one of the four
  spec-defined strings, must fail toward ALLOWED (same fail-safe direction as an absent header).
- Do not assume this closes the `GET /api/tasks/:id` DB-write finding by changing that handler — the fix
  is uniform, at the gateway chokepoint; no per-route change was made or is needed for that finding.
- Do not re-litigate the opaque-origin → `cross-site` claim as unverified — it was confirmed 2026-10-22
  against a real headless Chromium (see the Narrative's "Verified against a real browser" paragraph and
  project memory `b49e7983-sec-fetch-headers-measured`); a regression here would need a fresh repro, not
  a re-reading of the Fetch Metadata spec alone.

## Source

Inline comment in `packages/daemon/src/gateway/server.ts` (the CSRF/DNS-rebind `onRequest` hook, the
`Sec-Fetch-Site` addition immediately after the existing Origin check). Extracted at authoring time rather
than left as a 15+ line unanchored block, per this repo's comment-taxonomy convention.
