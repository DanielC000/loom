// SHARED TEST HELPER (card 76388dcb) — read the gateway loopback secret for a REAL spawned daemon.
//
// gateway/server.ts's loopback write guard (card 4ff9a073, 2026-08-07) requires an
// `Authorization: Bearer <secret>` header on every non-GET /api/* request — but ONLY when the secret
// file is present. A test that builds the gateway in-process never triggers this (no secret ⇒ guard
// inactive). A test that spawns a REAL daemon (dist/index.js) always does: `index.ts` mints the secret
// unconditionally, before `app.listen()` opens the port — so by the time your daemon answers a GET, the
// file is guaranteed to exist. A test that never reads it 401s on its very first write and nothing
// reports that (card 76388dcb: 12+ files, ~18 days of silent breakage, found by hand on
// 4f1d4276/profiles-rest.mjs — the reference fix this helper generalises).
//
// GET is never guarded — only call this once you actually need to send a write.
//
// USAGE (after your daemon is confirmed ready — waitReady()/equivalent, or a documented two-step "start
// the daemon first" test where the daemon is already up by the time this file runs):
//   import { readLoopbackToken, authHeaders } from "./_loopback-auth.mjs";
//   const loopbackToken = readLoopbackToken(LOOM_HOME);
//   await fetch(BASE + u, { method: "POST", headers: authHeaders(loopbackToken, true), body: ... });
import fs from "node:fs";
import path from "node:path";

/** Read + trim the loopback secret from a daemon's LOOM_HOME. Throws if the daemon isn't up yet. */
export function readLoopbackToken(loomHome) {
  return fs.readFileSync(path.join(loomHome, "gateway-loopback.key"), "utf8").trim();
}

/**
 * Build fetch() headers for a write: JSON content-type (only when a body is present, matching this
 * suite's existing convention of omitting it on a bodyless call) plus the Bearer auth header.
 * @param {string} token from readLoopbackToken()
 * @param {boolean} [hasBody] true when this request carries a JSON body
 */
export function authHeaders(token, hasBody = true) {
  return { ...(hasBody ? { "content-type": "application/json" } : {}), authorization: `Bearer ${token}` };
}
