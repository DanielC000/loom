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
 *  end, rate-limit clear) and their two read-only WS terminals. */
export type TrustTier = 0 | 1;

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
  { method: "POST", pattern: "/api/sessions/:id/input" },
  { method: "POST", pattern: "/api/sessions/:id/end" },
  { method: "POST", pattern: "/api/sessions/:id/stop" },
  { method: "POST", pattern: "/api/sessions/:id/resume" },
  { method: "POST", pattern: "/api/sessions/:id/rate-limit/clear" },
  // --- WS (tiered here; the actual token-on-upgrade check is Phase B) ---
  { method: "GET", pattern: "/ws/term/:sessionId" },
  { method: "GET", pattern: "/ws/companion/:sessionId" },
  // --- Phase C (card 6bc02f50) follow-up on 77ade04c: reads a remote read-only UI legitimately needs.
  //     Promoted DELIBERATELY, one at a time — nothing here writes, executes, or lifecycles anything. ---
  { method: "GET", pattern: "/api/version" },
  { method: "GET", pattern: "/api/update-status" },
  { method: "GET", pattern: "/api/orchestration/status" },
  { method: "GET", pattern: "/api/orchestration/events" },
  { method: "GET", pattern: "/api/projects/:id/git/log" },
  { method: "GET", pattern: "/api/projects/:id/git/branches" },
  { method: "GET", pattern: "/api/profiles" },
  { method: "GET", pattern: "/api/profiles/:id" },
  { method: "GET", pattern: "/api/skills" },
  { method: "GET", pattern: "/api/skills/:name" },
  // Archived lists
  { method: "GET", pattern: "/api/archived-sessions" },
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
 * Classify a route's trust tier. `routePattern` must be the Fastify-registered PATTERN (Fastify v5's
 * `req.routeOptions.url`), not the resolved request URL — so `/api/sessions/abc123/input` never matches;
 * only the literal registered pattern `/api/sessions/:id/input` does. DEFAULT-DENY: anything not an exact
 * `{method, pattern}` match in TIER_1_ROUTES is Tier 0, including every writer, `/internal/*`, and all
 * seven `/mcp*` mounts (none of which appear above).
 */
export function routeTier(method: string, routePattern: string): TrustTier {
  return TIER_1_SET.has(`${method.toUpperCase()} ${routePattern}`) ? 1 : 0;
}

/** Loopback hostnames a human may reasonably set `remoteAccess.bindHost` to (meaning: not actually remote). */
export function isLoopbackBindHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
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
