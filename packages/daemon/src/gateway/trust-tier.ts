import type { RemoteAccessConfig } from "@loom/shared";

/**
 * Access-story Phase A (card 766f8b50) — the per-route trust-tier wall. Loom's security today equates
 * loopback = trusted: there is no per-route auth, only the CSRF/DNS-rebind onRequest hook (gateway/
 * server.ts) and the `/internal/*` loopback (`req.ip`) gate. A future remote bind would silently expose
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
 *  end, rate-limit clear) and their two read-only WS terminals. Tier 2 (agent-tooling epic P5b, card
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
  // Lore = the per-project project_memory read (backs the /lore explorer page). Read-only, human-only,
  // project-scoped — same posture as the sibling board/tasks/vault project reads above.
  { method: "GET", pattern: "/api/projects/:id/memory" },
  { method: "GET", pattern: "/api/agents/:id/sessions" },
  { method: "GET", pattern: "/api/sessions/:id/queue" },
  { method: "GET", pattern: "/api/sessions/:id/wakes" },
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
  { method: "GET", pattern: "/api/projects/:id/git/log" },
  { method: "GET", pattern: "/api/projects/:id/git/branches" },
  { method: "GET", pattern: "/api/projects/:id/git/reference-repos/:index/log" },
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
 *  Phase C TLS mandate (see `tlsRequirementSatisfied`) does not apply to it. v1 is direct-bind + Tailscale
 *  only (no reverse-proxy), so a suffix match is sufficient — never treated as loopback. */
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
 * Fail-closed boot guard (BUILD item 4, extended by Phase C item 2): may a later phase actually open a
 * non-loopback listener? Only when `remoteAccess` requests one AND a gateway token already exists AND the
 * TLS mandate is satisfied — never "bind, then warn". `tokenExists` is Phase B's concern; `tlsFilesExist`
 * is Phase C's (see `tlsRequirementSatisfied`) — pass real checks once each mechanism exists; a stub that
 * always returns false is the conservative default until then (no token / no TLS ⇒ never able to open a
 * remote listener).
 */
export function canOpenRemoteListener(remoteAccess: RemoteAccessConfig, tokenExists: boolean, tlsFilesExist: boolean): boolean {
  return remoteAccess.enabled && !isLoopbackBindHost(remoteAccess.bindHost) && tokenExists
    && tlsRequirementSatisfied(remoteAccess, tlsFilesExist);
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
