// SHARED helper for a fixture that drives a real `/mcp*` route over HTTP against a REAL running daemon
// (as opposed to a real PtyHost/buildServer driven in-process — see that shape's own doc below).
//
// Card 280b1e44: every `/mcp*` route now requires `Authorization: Bearer <per-session mcpToken>`
// (packages/daemon/src/gateway/server.ts's onRequest hook + PtyHost.verifyMcpToken/isMcpReachable). A
// fixture that seeds a session row DIRECTLY into the DB (no real `claude`/codex spawn, so no real
// `Live`/`CodexLive` entry ever mints one) has no way to obtain a valid token the normal way. This module
// wraps the TEST-ONLY seam (`POST /internal/test/mcp-session/:sessionId`, PtyHost.registerTestMcpSession)
// that mints one — gated on BOTH `inTestMode()` and loopback on the daemon side, so it is structurally
// absent from a real end-user daemon regardless of whether a test happens to import this file.
//
// `LOOM_TEST=1` (armed by `./_guard.mjs`, which every fixture using this helper must import FIRST) is
// inherited into any daemon a fixture spawns via `env: { ...process.env, ... }` — verified against the
// real convention `platform-scope.mjs` already uses for its own isolated `dist/index.js` child. Without
// that inheritance the seam route 404s (`inTestMode()` false on the daemon side) exactly like it would on
// a real end-user daemon — the same fail-closed shape, not a special case for this helper to work around.
//
// NOT for an in-process `buildServer()` fixture with a REAL `PtyHost` subclass driving a REAL `spawn()`
// (e.g. tool-attribution-join.mjs, hook-cross-session-forge.mjs) — that shape already has the real,
// spawn-minted `mcpToken` available for free (capture it the same way those fixtures already capture
// `hookToken`, via a `createPty(opts, hookToken, mcpToken)` override) and should use THAT, never this
// seam — minting a duplicate test-only token for a session that already has a real one is pointless and
// makes `verifyMcpToken`'s own "prefer the real Live entry" precedence untested.

/** Mints a valid mcpToken for `sessionId` against a real, already-running daemon at `base` (e.g.
 *  `http://127.0.0.1:4318`). Throws with a clear message on any non-200 (e.g. the daemon wasn't started
 *  with LOOM_TEST=1, or a real session already exists for this id). */
export async function mintTestMcpToken(base, sessionId) {
  const res = await fetch(`${base}/internal/test/mcp-session/${encodeURIComponent(sessionId)}`, { method: "POST" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`mintTestMcpToken(${sessionId}) failed: ${res.status} ${body}`);
  }
  const { mcpToken } = await res.json();
  if (typeof mcpToken !== "string" || !mcpToken) throw new Error(`mintTestMcpToken(${sessionId}): daemon returned no mcpToken`);
  return mcpToken;
}

/** The `StreamableHTTPClientTransportOptions.requestInit` shape carrying the Bearer header — spread this
 *  into the transport's own options object: `new StreamableHTTPClientTransport(url, mcpAuthRequestInit(token))`. */
export function mcpAuthRequestInit(token) {
  return { requestInit: { headers: { Authorization: `Bearer ${token}` } } };
}

/** A MINIMAL in-process fake of PtyHost's three /mcp* auth methods (`registerTestMcpSession`,
 *  `verifyMcpToken`, `isMcpReachable`), for a fixture that builds its OWN plain `deps.pty` stub object
 *  (e.g. `{ markMcpSeen: () => {} }`) rather than a real `PtyHost` instance or a spawned daemon child
 *  process. Spread the result into that stub — `{ ...myPtyStub, ...mcpAuthStub() }` — so every DB-only
 *  seeded session id this fixture connects with gets a real, verifiable per-session token, exactly like
 *  the production seam (`PtyHost.registerTestMcpSession`) does for a fixture that instead talks to a real
 *  daemon over HTTP. Deliberately NOT the same object/Map as any other fixture's own instance — each call
 *  to this factory returns an independent token store. */
export function mcpAuthStub() {
  const tokens = new Map();
  return {
    registerTestMcpSession(sessionId) {
      const token = `test-${sessionId}-${Math.random().toString(36).slice(2)}`;
      tokens.set(sessionId, token);
      return token;
    },
    verifyMcpToken(sessionId, token) {
      return typeof token === "string" && token.length > 0 && tokens.get(sessionId) === token;
    },
    isMcpReachable(sessionId) {
      return tokens.has(sessionId);
    },
  };
}
