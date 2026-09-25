import { isIP as netIsIP } from "node:net";
import type { IncomingMessage } from "node:http";
import type { RemoteAccessConfig } from "@loom/shared";

/**
 * Access-story Phase A (card 766f8b50) — the per-route trust-tier wall. Loom's security today equates
 * loopback = trusted: there is no per-route auth, only the CSRF/DNS-rebind onRequest hook (gateway/
 * server.ts) and the `/internal/*` loopback (peer) gate. A future remote bind would silently expose
 * every human-only writer unless the trust tier is made EXPLICIT per route first. This module is that
 * wall: `routeTier` classifies a route FAIL-CLOSED (default Tier 0), and `canOpenRemoteListener` is the
 * boot-time guard a later phase's `.listen()` consults before ever binding non-loopback.
 *
 * SHIPS INERT: nothing here runs unless a caller wires it in behind `remoteAccess.enabled` — see the
 * onRequest hook in gateway/server.ts, which is dormant (and byte-identical to today) whenever
 * `remoteAccess.enabled` is false or `bindHost` is loopback (the default).
 */

/** Tier 0 = loopback-only (fail-closed default). Tier 1 = safe to allow over an authenticated remote
 *  bind — reads, plus the human answer/steer surfaces (Requests inbox answer, session input/stop/resume/
 *  end, rate-limit clear) and the three WS routes (/ws/term, /ws/companion, /ws/fleet). Being Tier 1 does
 *  NOT make a WS read-only: /ws/term gives a remote peer a view plus a repaint only and refuses host shells
 *  outright (@decision 710a34fa), /ws/companion deliberately accepts remote chat, /ws/fleet is a push feed. Tier 2 (agent-tooling epic P5b, card
 *  8fbedcac) = the inbound webhook ingress: a DIFFERENT trust model from Tier 1 — PUBLIC (no gateway
 *  token accepted at all) but SIGNATURE-gated (the route's own per-endpoint HMAC verify is the real
 *  authorization, see webhooks/ingress.ts). A Tier-1 gateway token has no effect on a Tier-2 route, and a
 *  Tier-2 request never grants Tier-1 access — the two tiers are isolated by construction, not by a
 *  denylist check (see the onRequest hook in gateway/server.ts, which never reads Authorization for a
 *  Tier-2 route in the first place). */
export type TrustTier = 0 | 1 | 2;

interface TierRule {
  method: string;
  /** The Fastify-registered route PATTERN (e.g. "/api/sessions/:id/input"), not a resolved URL. */
  pattern: string;
}

/**
 * The COMPLETE Tier-1 allowlist. Anything not listed here is Tier 0 by construction — adding a new route
 * to the gateway does NOT require touching this file, it just stays Tier-0 (loopback-only) until someone
 * deliberately allowlists it here. Verified against the real route registrations in gateway/server.ts.
 */
const TIER_1_ROUTES: readonly TierRule[] = [
  // --- Reads ---
  { method: "GET", pattern: "/api/projects" },
  { method: "GET", pattern: "/api/sessions" },
  { method: "GET", pattern: "/api/sessions/:id/transcript" },
  { method: "GET", pattern: "/api/sessions/:id/diff" },
  { method: "GET", pattern: "/api/projects/:id/board" },
  { method: "GET", pattern: "/api/projects/:id/tasks" },
  { method: "GET", pattern: "/api/projects/:id/agents" },
  // Memory = the per-project project_memory read (backs the /memory explorer page). Read-only, human-only,
  // project-scoped — same posture as the sibling board/tasks/vault project reads above.
  { method: "GET", pattern: "/api/projects/:id/memory" },
  { method: "GET", pattern: "/api/agents/:id/sessions" },
  { method: "GET", pattern: "/api/sessions/:id/queue" },
  { method: "GET", pattern: "/api/sessions/:id/wakes" },
  // Gates page reads (card a1c86452): the live active-gate snapshot + paginated gate history. Read-only,
  // human-only, cross-project god-eye — same posture as the audit/orchestration-events reads below.
  { method: "GET", pattern: "/api/gates/active" },
  { method: "GET", pattern: "/api/gates/history" },
  // Audit / usage reads
  { method: "GET", pattern: "/api/audit/session/:id" },
  { method: "GET", pattern: "/api/audit/wave/:managerId" },
  { method: "GET", pattern: "/api/audit/diff" },
  { method: "GET", pattern: "/api/usage/limits" },
  { method: "GET", pattern: "/api/usage/history" },
  { method: "GET", pattern: "/api/usage/sessions/history" },
  // Vault reads (writers stay Tier-0 — different methods on the same paths)
  { method: "GET", pattern: "/api/projects/:id/vault" },
  { method: "GET", pattern: "/api/projects/:id/vault/file" },
  { method: "GET", pattern: "/api/projects/:id/vault/raw" },
  // Requests inbox reads
  { method: "GET", pattern: "/api/questions" },
  { method: "GET", pattern: "/api/questions/:id" },
  // --- Answer / steer (first-person human actions on an already-running session) ---
  { method: "POST", pattern: "/api/questions/:id/answer" },
  { method: "POST", pattern: "/api/questions/:id/dismiss" },
  { method: "POST", pattern: "/api/sessions/:id/input" },
  { method: "POST", pattern: "/api/sessions/:id/end" },
  { method: "POST", pattern: "/api/sessions/:id/stop" },
  { method: "POST", pattern: "/api/sessions/:id/resume" },
  { method: "POST", pattern: "/api/sessions/:id/rate-limit/clear" },
  // --- WS (tiered here; the actual token-on-upgrade check is Phase B) ---
  { method: "GET", pattern: "/ws/term/:sessionId" },
  { method: "GET", pattern: "/ws/companion/:sessionId" },
  // C2 of the WS delta-push umbrella (1efde4ba): pushes the SAME data GET /api/sessions already serves
  // Tier-1 (no new exposure) — see the route's own doc comment in gateway/server.ts. NO event data flows
  // over this route yet (that's C7); a `sub:events` message in this card is bookkeeping only.
  { method: "GET", pattern: "/ws/fleet" },
  // --- Phase C (card 6bc02f50) follow-up on 77ade04c: reads a remote read-only UI legitimately needs.
  //     Promoted DELIBERATELY, one at a time — nothing here writes, executes, or lifecycles anything. ---
  { method: "GET", pattern: "/api/version" },
  { method: "GET", pattern: "/api/update-status" },
  { method: "GET", pattern: "/api/orchestration/status" },
  { method: "GET", pattern: "/api/orchestration/events" },
  // Read-only schedule run-history (the schedule-fire events) — pure read, no lifecycle. The schedule
  // WRITERS on /api/schedules stay Tier-0.
  { method: "GET", pattern: "/api/schedules/history" },
  { method: "GET", pattern: "/api/projects/:id/git/log" },
  { method: "GET", pattern: "/api/projects/:id/git/branches" },
  { method: "GET", pattern: "/api/projects/:id/git/reference-repos/:index/log" },
  // Sibling of the reference-repos log above and the same trust class: a read-only git log for one of
  // the project's OWN registered repos, resolved server-side from an INDEX the client supplies (never a
  // host path). Tier-1 for the same reason — without this the Git page would serve one repo's log and
  // 403 the identical panel next to it under a remote bind.
  { method: "GET", pattern: "/api/projects/:id/git/repos/:index/log" },
  { method: "GET", pattern: "/api/profiles" },
  { method: "GET", pattern: "/api/profiles/:id" },
  { method: "GET", pattern: "/api/skills" },
  { method: "GET", pattern: "/api/skills/:name" },
  // Archived lists
  { method: "GET", pattern: "/api/archived-sessions" },
  { method: "GET", pattern: "/api/archived-sessions/:id" },
  { method: "GET", pattern: "/api/projects/:id/archive" },
  { method: "GET", pattern: "/api/projects/archived" },
  // Companion reads (writers on the SAME paths — POST/PUT/DELETE — stay Tier-0)
  { method: "GET", pattern: "/api/companion/:sessionId/grants" },
  { method: "GET", pattern: "/api/companion/allowed-senders" },
  { method: "GET", pattern: "/api/companion/bindings" },
  { method: "GET", pattern: "/api/companion/config" },
  { method: "GET", pattern: "/api/companion/config/:sessionId" },
  { method: "GET", pattern: "/api/companion/conversations/:sessionId" },
  { method: "GET", pattern: "/api/companion/conversations/:sessionId/:seq" },
  { method: "GET", pattern: "/api/companion/home" },
  { method: "GET", pattern: "/api/companion/:sessionId/lead-mode" },
  { method: "GET", pattern: "/api/companion/memory/:sessionId" },
  { method: "GET", pattern: "/api/companion/memory/:sessionId/:name" },
  { method: "GET", pattern: "/api/companion/messages/:sessionId" },
  { method: "GET", pattern: "/api/companion/prompt/:sessionId" },
  { method: "GET", pattern: "/api/companion/reminders/:sessionId" },
  { method: "GET", pattern: "/api/companion/restricted-tools/:sessionId" },
  { method: "GET", pattern: "/api/companion/skills/:sessionId" },
  // Runtime reply-health (card 8bda9fc6) — pure derived telemetry, no secrets, no lifecycle.
  { method: "GET", pattern: "/api/companion/status" },
  { method: "GET", pattern: "/api/companion/status/:sessionId" },
  { method: "GET", pattern: "/api/companion/skills/:sessionId/:name" },
  { method: "GET", pattern: "/api/companion/voice-prefs/:sessionId" },
];

const TIER_1_SET: ReadonlySet<string> = new Set(TIER_1_ROUTES.map((r) => `${r.method} ${r.pattern}`));

/**
 * The COMPLETE Tier-2 allowlist (card 8fbedcac) — deliberately just the ONE fixed registered pattern the
 * webhook ingress mounts every endpoint under (`webhooks/ingress.ts`); the actual per-instance endpoint
 * identity lives in the DB row looked up by `:endpointPath`, never in the route pattern itself, so this
 * classifier stays a static-table lookup exactly like Tier 1.
 */
const TIER_2_ROUTES: readonly TierRule[] = [
  { method: "POST", pattern: "/hooks/:endpointPath" },
];
const TIER_2_SET: ReadonlySet<string> = new Set(TIER_2_ROUTES.map((r) => `${r.method} ${r.pattern}`));

/**
 * Classify a route's trust tier. `routePattern` must be the Fastify-registered PATTERN (Fastify v5's
 * `req.routeOptions.url`), not the resolved request URL — so `/api/sessions/abc123/input` never matches;
 * only the literal registered pattern `/api/sessions/:id/input` does. DEFAULT-DENY: anything not an exact
 * `{method, pattern}` match in TIER_1_ROUTES or TIER_2_ROUTES is Tier 0, including every writer,
 * `/internal/*`, and all seven `/mcp*` mounts (none of which appear in either allowlist).
 */
export function routeTier(method: string, routePattern: string): TrustTier {
  const key = `${method.toUpperCase()} ${routePattern}`;
  if (TIER_1_SET.has(key)) return 1;
  if (TIER_2_SET.has(key)) return 2;
  return 0;
}

/**
 * The SPA shell (card 4cbbc343, owner flag F1): the ONE route pattern `@fastify/static` registers for the built web app
 * (`GET|HEAD /*`, registered without a prefix in gateway/server.ts) — it matches only what no daemon route matched, and
 * its handler can only serve a file under the web dist, the SPA fallback, or (for a reserved path) the JSON 404. Keyed on
 * the MATCHED pattern, never on the request path text (the tier wall's own invariant). The trusted-proxy class alone is
 * exempted from the gateway-token requirement for it — a browser must load the app before it can present a token; the
 * remote listener stays API-only and every non-shell route still needs the token.
 */
export function isStaticShellRoute(method: string, routePattern: string | undefined): boolean {
  const m = method.toUpperCase();
  return routePattern === "/*" && (m === "GET" || m === "HEAD");
}

/** Loopback hostnames a human may reasonably set `remoteAccess.bindHost` to (meaning: not actually remote). */
export function isLoopbackBindHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * The "all interfaces" bind targets (P5b hardening follow-up, card 80e2093f, item 2) — `0.0.0.0` (IPv4
 * any-address) and its IPv6 counterpart `::`. `isValidBindHostShape` (mcp/platform.ts) has always accepted
 * these (LAN-in-scope is an explicit, owner-decided supported mode, NOT an auth bypass — every non-loopback
 * peer still hits the same token+TLS wall), but binding every interface deserves to be VISIBLE rather than
 * silent. Used at the boot `.listen()` call site (index.ts) to log when this mode is actually opened, and by
 * the Settings UI to show a "reachable from your LAN" hint next to the resolved bindHost.
 */
export function isAllInterfacesBindHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

/** A Tailscale (`.ts.net`) tailnet address — already end-to-end encrypted by the tailnet itself, so the
 *  Phase C TLS mandate (see `tlsRequirementSatisfied`) does not apply to it. This is about a DIRECT bind to a
 *  tailnet address; a same-host reverse proxy (`tailscale serve`) goes through the separate trusted-proxy listener
 *  (`resolveRemoteTrust`), never through this check. A suffix match is sufficient — never treated as loopback. */
export function isTailnetHost(host: string): boolean {
  return host.toLowerCase().endsWith(".ts.net");
}

/**
 * Is the trust-tier hook LIVE for this request? Mirrors the "ships inert" contract: dormant (returns
 * false) unless a non-loopback bind is actually configured, so a request on today's loopback-only daemon
 * never enters the tier check at all — byte-identical behavior.
 */
export function isTrustTierHookActive(remoteAccess: RemoteAccessConfig): boolean {
  return remoteAccess.enabled && !isLoopbackBindHost(remoteAccess.bindHost);
}

/**
 * Phase C TLS mandate (BUILD item 2): wss-only-over-untrusted-transport. Satisfied when the bind target
 * is already an encrypted tailnet link (`isTailnetHost`), OR `remoteAccess.tls` is configured AND its
 * cert/key files are actually present on disk. `tlsFilesExist` is a caller-supplied check (an
 * `fs.existsSync` at each call site — gateway/server.ts for the https construction, index.ts for the
 * `.listen()` host decision) so this stays a pure, fs-free, unit-testable function.
 */
export function tlsRequirementSatisfied(remoteAccess: RemoteAccessConfig, tlsFilesExist: boolean): boolean {
  if (isTailnetHost(remoteAccess.bindHost)) return true;
  return !!remoteAccess.tls && tlsFilesExist;
}

/**
 * Canonical form of a host for allowlist matching (card 23496950): brackets stripped, lower-cased, and IPv6
 * literals compressed exactly as the WHATWG URL parser (which produces the request's Host/Origin hostname)
 * would — so `2001:db8:0:0:0:0:0:1` matches a client that sent `[2001:db8::1]`. Returns `null` for anything
 * that can't be canonicalised UNAMBIGUOUSLY: notably a hostname-shaped string the URL parser would silently
 * reinterpret as an IPv4 address (`0x7f.0.0.1` and `2130706433` both become 127.0.0.1; `192.168.001.050` is
 * read as OCTAL, i.e. 192.168.1.40), which would let a loopback address through a naive loopback check or
 * make an entry match a different machine than the human typed.
 */
export function canonicalHost(host: string): string | null {
  const h = host.trim().replace(/^\[(.*)\]$/, "$1");
  if (h === "") return null;
  const kind = netIsIP(h);
  let parsed: string;
  try { parsed = new URL(`http://${kind === 6 ? `[${h}]` : h}`).hostname; } catch { return null; }
  parsed = parsed.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (kind === 0 && netIsIP(parsed) !== 0) return null; // a name the URL parser turned into an IP — ambiguous
  return parsed;
}

/**
 * A host that may NEVER appear in `remoteAccess.allowedHosts` (card 23496950): anything that cannot be
 * canonicalised unambiguously, the all-interfaces literals (a client never dials them, and matching them
 * would re-open the `Host: 0.0.0.0` hole) and every loopback-equivalent form (loopback has its own, stricter,
 * peer-scoped rule — an allowlist entry for it would only blur that). The check runs on the CANONICAL form, so
 * `::0:1`, `::ffff:7f00:1` and `0:0:0:0:0:0:0:1` are caught as well as the plain spellings.
 */
export function isForbiddenAllowedHost(host: string): boolean {
  const c = canonicalHost(host);
  if (c === null) return true;
  if (c === "localhost" || c.endsWith(".localhost")) return true;
  if (c === "0.0.0.0" || c === "::" || c === "::1") return true;
  if (/^127\./.test(c) || /^0\./.test(c)) return true;
  if (/^::ffff:(7f[0-9a-f]{2}:[0-9a-f]{1,4}|0:0)$/.test(c)) return true; // IPv4-mapped 127.x / 0.0.0.0
  if (/^::7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(c)) return true; // deprecated IPv4-compatible 127.x
  return false;
}

/** The exact (canonical) hostnames a NON-loopback peer may present as Host/Origin: the configured `bindHost`
 *  (unless it is an all-interfaces literal, which no client dials) plus `allowedHosts`. An entry that cannot
 *  be canonicalised is dropped — fail-closed. */
export function remoteHostAllowlist(remoteAccess: RemoteAccessConfig): string[] {
  const out = new Set<string>();
  if (!isAllInterfacesBindHost(remoteAccess.bindHost)) {
    const c = canonicalHost(remoteAccess.bindHost);
    if (c !== null) out.add(c);
  }
  for (const h of remoteAccess.allowedHosts ?? []) {
    const c = canonicalHost(h);
    if (c !== null) out.add(c);
  }
  return [...out];
}

// @decision 4cbbc343 — `requestClass` is the ONLY place a request's trust class is decided: no other file reads a
// peer address or compares to a loopback literal, and the class follows the LISTENER, never a Host/Origin header.

/**
 * The ONE 401 body a remote-class request without a valid gateway token gets — the remote listener (card b855c37d) and the
 * trusted-proxy listener (card 4cbbc343) share it. `error` stays byte-identical; `code` + `hint` are additive. Absent and
 * wrong tokens get the identical body (no oracle), and the hint names no path, secret, or `loom open` pointer (that pointer is
 * the LOOPBACK guard's own credential, which must never arm on this 401 — decision 093981dd).
 */
export const GATEWAY_TOKEN_REQUIRED_BODY: Readonly<{ error: string; code: string; hint: string }> = Object.freeze({
  error: "unauthorized",
  code: "gateway-token-required",
  hint: "This remote request needs a gateway token: send it as `Authorization: Bearer <token>`.",
});

const LOOPBACK_PEERS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** How a request came to be trusted as loopback, or which door made it remote.
 *  - `peer`: a non-loopback (or undeterminable) TCP peer.
 *  - `remote-listener`: arrived on the remote listener, even from a loopback peer (card d0f3c8ea).
 *  - `proxy`: arrived on the trusted-proxy listener (card 4cbbc343) — the peer is the local reverse proxy.
 *  - `forwarded`: a loopback peer on the daemon's own port carrying proxy-shaped headers, while proxy mode is
 *    configured — a mis-pointed proxy, or a forgery; only ever LOWERS trust. */
export type RemoteVia = "peer" | "remote-listener" | "proxy" | "forwarded";
export type RequestClass = { kind: "loopback" } | { kind: "remote"; via: RemoteVia };

const LOOPBACK_CLASS: RequestClass = { kind: "loopback" };
const REMOTE_CLASSES: Readonly<Record<RemoteVia, RequestClass>> = {
  peer: { kind: "remote", via: "peer" }, "remote-listener": { kind: "remote", via: "remote-listener" },
  proxy: { kind: "remote", via: "proxy" }, forwarded: { kind: "remote", via: "forwarded" },
};

const remoteListenerRequests = new WeakSet<object>();
const proxyListenerRequests = new WeakSet<object>();
/** Called by the remote listener for every request/upgrade it receives (before `app.routing`/the forwarder). */
export function markRemoteListenerRequest(req: IncomingMessage): void { remoteListenerRequests.add(req); }
/** Called by the trusted-proxy listener for every request/upgrade it receives. */
export function markProxyListenerRequest(req: IncomingMessage): void { proxyListenerRequests.add(req); }

/** A header a reverse proxy adds (`X-Forwarded-*`, `Forwarded`, `Via`, `X-Real-IP`, `Tailscale-*`). */
function hasProxyShapedHeader(headers: IncomingMessage["headers"]): boolean {
  for (const name of Object.keys(headers)) {
    if (name === "forwarded" || name === "via" || name === "x-real-ip" || name.startsWith("x-forwarded-") || name.startsWith("tailscale-")) return true;
  }
  return false;
}

/**
 * Classify a request. FAIL-CLOSED: an empty/undeterminable peer address is remote. Pure apart from reading the
 * two listener marks. `proxyMode` = trusted-proxy mode is configured (see `resolveRemoteTrust`).
 */
export function requestClass(req: IncomingMessage, opts: { proxyMode: boolean }): RequestClass {
  if (proxyListenerRequests.has(req)) return REMOTE_CLASSES.proxy;
  if (remoteListenerRequests.has(req)) return REMOTE_CLASSES["remote-listener"];
  if (!LOOPBACK_PEERS.has(req.socket?.remoteAddress ?? "")) return REMOTE_CLASSES.peer;
  if (opts.proxyMode && hasProxyShapedHeader(req.headers)) return REMOTE_CLASSES.forwarded;
  return LOOPBACK_CLASS;
}

/** The TCP peer address, ONLY for keying rate limits / lockouts — never for a trust decision (that is
 *  `requestClass`). Empty string when undeterminable. */
export function peerAddressOf(req: IncomingMessage): string { return req.socket?.remoteAddress ?? ""; }

const TRUSTED_ORIGIN_HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Canonical form of a `remoteAccess.trustedProxyOrigins` entry, or `null` when it is not acceptable: exactly
 * `scheme://host[:port]` (no path — not even `/` — query, fragment, userinfo, wildcard or trailing dot), https
 * unless the host is a `.ts.net` name, and a host that is not loopback/wildcard/ambiguous
 * (`isForbiddenAllowedHost`). The result is `new URL().origin` (lower-case, default port stripped).
 */
export function canonicalTrustedProxyOrigin(raw: string): string | null {
  if (typeof raw !== "string" || raw !== raw.trim() || raw.includes("*")) return null;
  const m = /^(https?):\/\/([^/?#@\s]+)$/i.exec(raw);
  if (!m) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (host === "" || host.endsWith(".")) return null;
  if (netIsIP(host) === 0 && !TRUSTED_ORIGIN_HOST_RE.test(host)) return null;
  if (isForbiddenAllowedHost(host)) return null;
  if (url.protocol === "http:" && !isTailnetHost(host)) return null;
  return url.origin;
}

/** The canonical, de-duplicated `trustedProxyOrigins` (entries that fail canonicalisation are dropped — fail-closed). */
export function trustedProxyOriginList(remoteAccess: RemoteAccessConfig): string[] {
  const out = new Set<string>();
  for (const raw of remoteAccess.trustedProxyOrigins ?? []) {
    const c = canonicalTrustedProxyOrigin(raw);
    if (c !== null) out.add(c);
  }
  return [...out];
}

/** Characters a Host header value may contain for the trusted-proxy match — anything else (userinfo `@`, a
 *  path, whitespace) is refused outright rather than parsed. */
const PROXY_HOST_HEADER_RE = /^[A-Za-z0-9.:[\]-]+$/;

/**
 * The trusted-proxy Host rule: the Host header must equal the host[:port] of one entry (default port of the
 * ENTRY's scheme applied — `x.ts.net` equals `x.ts.net:443` for an https entry; a trailing-dot host never matches).
 * Returns the matching canonical origin, or `null`.
 */
export function trustedProxyEntryForHost(hostHeader: string | undefined, origins: readonly string[]): string | null {
  if (typeof hostHeader !== "string" || hostHeader === "" || !PROXY_HOST_HEADER_RE.test(hostHeader)) return null;
  for (const origin of origins) {
    let want: URL, got: URL;
    try { want = new URL(origin); got = new URL(`${want.protocol}//${hostHeader}`); } catch { continue; }
    if (got.hostname.endsWith(".")) continue;
    if (got.host === want.host) return origin;
  }
  return null;
}

/** The trusted-proxy Origin rule: absent is allowed (a non-browser client); anything PRESENT — including the empty
 *  string and `null` — must canonicalise to EXACTLY the entry the Host matched. */
export function proxyOriginAllowed(originHeader: string | string[] | undefined, entry: string): boolean {
  if (originHeader === undefined) return true;
  if (typeof originHeader !== "string" || originHeader === "") return false;
  try { return new URL(originHeader).origin.toLowerCase() === entry; } catch { return false; }
}

/** The ONE source of truth for whether remote trust is live, computed once from config (card 4cbbc343 M1). */
export interface RemoteTrust {
  /** The trust-tier wall is registered (a remote listener OR proxy mode is configured). */
  tierWall: boolean;
  /** Proxy mode is configured: `enabled` + a `proxyPort` + at least one valid trusted origin. */
  proxyMode: boolean;
  /** Canonical trusted origins (empty unless `proxyMode`). */
  trustedOrigins: string[];
}
export function resolveRemoteTrust(remoteAccess: RemoteAccessConfig): RemoteTrust {
  const origins = remoteAccess.enabled && remoteAccess.proxyPort !== undefined ? trustedProxyOriginList(remoteAccess) : [];
  const proxyMode = origins.length > 0;
  return { tierWall: isTrustTierHookActive(remoteAccess) || proxyMode, proxyMode, trustedOrigins: origins };
}

/** Why the trusted-proxy listener may not open — empty when it may (mirrors `remoteListenerRefusalReasons`). */
export function proxyListenerRefusalReasons(remoteAccess: RemoteAccessConfig, tokenExists: boolean, ports: { loopbackPort: number; remotePort: number | null }): string[] {
  const reasons: string[] = [];
  if (!remoteAccess.enabled) reasons.push("remoteAccess.enabled is false");
  if (remoteAccess.proxyPort === undefined) reasons.push("remoteAccess.proxyPort is not set");
  const origins = trustedProxyOriginList(remoteAccess);
  if (origins.length === 0) reasons.push("remoteAccess.trustedProxyOrigins has no valid entry");
  if (!tokenExists) reasons.push("no gateway token exists yet");
  if (remoteAccess.proxyPort !== undefined && remoteAccess.proxyPort === ports.loopbackPort) reasons.push(`remoteAccess.proxyPort (${remoteAccess.proxyPort}) equals the loopback listener's port`);
  if (remoteAccess.proxyPort !== undefined && ports.remotePort !== null && remoteAccess.proxyPort === ports.remotePort) reasons.push(`remoteAccess.proxyPort (${remoteAccess.proxyPort}) equals the remote listener's port`);
  const hosts = new Set(remoteHostAllowlist(remoteAccess));
  for (const o of origins) {
    const h = new URL(o).hostname.replace(/^\[(.*)\]$/, "$1");
    if (hosts.has(h)) reasons.push(`trustedProxyOrigins host ${h} is also a remote allowedHosts/bindHost entry — the two classes must stay disjoint`);
  }
  return reasons;
}

/**
 * Why a requested remote listener may not open — empty when it may. The ONE place the fail-closed rules
 * live (`canOpenRemoteListener` is `enabled && reasons.length === 0`), so the boot log can name every real
 * reason honestly instead of re-deriving them. `tlsLoaded` is the REAL signal that the remote server's TLS
 * material was read and accepted (see gateway/remote-listener.ts) — never a file-existence guess.
 */
export function remoteListenerRefusalReasons(remoteAccess: RemoteAccessConfig, tokenExists: boolean, tlsLoaded: boolean): string[] {
  const reasons: string[] = [];
  if (!tokenExists) reasons.push("no gateway token exists yet");
  if (!tlsRequirementSatisfied(remoteAccess, tlsLoaded)) {
    reasons.push(remoteAccess.tls
      ? "the configured TLS cert/key did not load (see the earlier [gateway] warning for why)"
      : "TLS is required for a non-tailnet remote bind but remoteAccess.tls is not configured");
  }
  if (isAllInterfacesBindHost(remoteAccess.bindHost) && remoteHostAllowlist(remoteAccess).length === 0) {
    reasons.push("a wildcard bindHost needs remoteAccess.allowedHosts (the exact hostnames/IPs clients will use) — without it no remote Host could ever pass the DNS-rebind check");
  }
  return reasons;
}

/**
 * Fail-closed boot guard: may the daemon actually open its remote listener? Only when `remoteAccess`
 * requests a non-loopback bind AND a gateway token already exists AND the TLS mandate is satisfied AND (for
 * a wildcard bind) an explicit host allowlist exists — never "bind, then warn".
 */
export function canOpenRemoteListener(remoteAccess: RemoteAccessConfig, tokenExists: boolean, tlsLoaded: boolean): boolean {
  return remoteAccess.enabled && !isLoopbackBindHost(remoteAccess.bindHost)
    && remoteListenerRefusalReasons(remoteAccess, tokenExists, tlsLoaded).length === 0;
}

/**
 * WS double-subprotocol handshake (P5b hardening spike amendment #3, card 42abca6a). Fixed the ws@8 leak
 * where, absent a custom `handleProtocols`, `WebSocketServer.completeUpgrade` echoes the FIRST
 * client-offered subprotocol verbatim into the `101` response's `Sec-WebSocket-Protocol` header — and
 * since the gateway token WAS that first/sole subprotocol (the old `proto.split(",")[0]` extraction in
 * gateway/server.ts), the presented credential was reflected in a response header on every successful
 * remote WS connect (capturable by any TLS-terminating proxy / log aggregator downstream). The fix: a
 * remote client now offers TWO subprotocol entries — the fixed generic marker PLUS a token-carrying
 * entry — and the server's own echoed choice (`selectWsSubprotocol`) is ALWAYS the generic marker, never
 * the token-carrying one.
 */
export const WS_GENERIC_SUBPROTOCOL = "loom.v1";

/** Prefix of the token-carrying subprotocol entry a remote WS client offers ALONGSIDE (never instead of)
 *  `WS_GENERIC_SUBPROTOCOL` — see `resolveWsSubprotocolToken`. */
export const WS_BEARER_PREFIX = "loom.bearer.";

/**
 * ws's own `handleProtocols` hook (wired into the `@fastify/websocket` registration in gateway/
 * server.ts): given the set of subprotocols a client offered, choose what the `101` response echoes
 * back. ALWAYS the fixed generic marker when the client offered it — NEVER a `WS_BEARER_PREFIX`-prefixed
 * (token-carrying) entry, even if one was offered. Returns `false` (no protocol negotiated, matching ws's
 * own no-`handleProtocols` behavior when the offered set is empty) when the client didn't offer the
 * generic marker at all. ws only invokes this at all when the client sent a `Sec-WebSocket-Protocol`
 * header in the first place — a loopback client that offers no subprotocol never reaches this hook, so
 * that path is unaffected by construction, not by a special case here.
 */
export function selectWsSubprotocol(offered: ReadonlySet<string> | readonly string[]): string | false {
  const set = offered instanceof Set ? offered : new Set(offered);
  return set.has(WS_GENERIC_SUBPROTOCOL) ? WS_GENERIC_SUBPROTOCOL : false;
}

export type WsTokenResolution =
  | { outcome: "token"; token: string }
  /** No subprotocol-carried token to extract — caller falls back to the `?token=` query param (or, for a
   *  loopback request, no token at all). NOT a rejection: a bare generic-only offer, or no
   *  `Sec-WebSocket-Protocol` header at all, both land here. */
  | { outcome: "no-token" }
  /** A `WS_BEARER_PREFIX` entry was offered WITHOUT the generic marker alongside it — the malformed/legacy
   *  single-subprotocol shape the old leak relied on. Rejected outright; the caller must NOT fall back to
   *  the `?token=` query param for this case (an attacker can't dodge the rejection by adding a query
   *  token to a non-conformant subprotocol offer). */
  | { outcome: "rejected" };

/**
 * Resolve a gateway token from a WS upgrade's raw `Sec-WebSocket-Protocol` header value under the
 * two-entry contract, replacing the old positional `proto.split(",")[0]` extraction (which trusted
 * whatever the client put first). The token is only honored when the client offered
 * `WS_GENERIC_SUBPROTOCOL` in the SAME list as the `WS_BEARER_PREFIX` entry — extracted BY PREFIX, not
 * positionally, so entry order in the client's offer doesn't matter.
 */
export function resolveWsSubprotocolToken(headerValue: string | undefined): WsTokenResolution {
  if (typeof headerValue !== "string") return { outcome: "no-token" };
  const offered = headerValue.split(",").map((p) => p.trim()).filter(Boolean);
  const hasGeneric = offered.includes(WS_GENERIC_SUBPROTOCOL);
  const bearerEntry = offered.find((p) => p.startsWith(WS_BEARER_PREFIX));
  if (!bearerEntry) return { outcome: "no-token" };
  if (!hasGeneric) return { outcome: "rejected" };
  const token = bearerEntry.slice(WS_BEARER_PREFIX.length);
  return token ? { outcome: "token", token } : { outcome: "no-token" };
}
