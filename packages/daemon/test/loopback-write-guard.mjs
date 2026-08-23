import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 9ccedbee (SECURITY) — the loopback human-only-write guard: any co-resident process (an agent
// session's own Bash tool included) could `curl` a REST writer, or open a `/ws/term` socket, directly and
// bypass the MCP tool surface entirely, because the daemon's default (no remoteAccess) posture trusted
// loopback UNCONDITIONALLY — no per-route auth at all beyond the CSRF/Host hook, which a same-host curl
// trivially satisfies. Driven via buildServer + app.inject/injectWS (HERMETIC + CLAUDE-FREE + NETWORK-
// FREE, like gateway-hardening.mjs and trust-tier.mjs).
//
// v2 (Code Review Critical): v1 only gated routeTier===0 writes, leaving every Tier-1 route open —
// exactly where the human's AUTHORITY lives (POST /api/sessions/:id/input feeds `ownerText`, the
// anti-fabrication invariant's whole premise is "this comes from the SAME loopback-only, human-
// authenticated composer"; POST /api/questions/:id/answer is a direct human decision; /ws/term's
// `{type:"stdin"}` writes raw bytes into ANY session's pty). v2 gates EVERY non-GET `/api/*` route PLUS
// the `/ws/term` upgrade — no Tier distinction. Covers:
//   (A) BACKWARD COMPAT: `loopbackSecret` omitted from GatewayDeps (every existing partial-stub test) →
//       the guard is a no-op for BOTH the REST write AND the /ws/term upgrade — unchanged.
//   (B) THE BYPASS, closed: with `loopbackSecret` wired, a Tier-0 write (PATCH /api/platform/config) with
//       NO Authorization header now 401s.
//   (C) a WRONG bearer value also 401s.
//   (D) POSITIVE CONTROL: the CORRECT bearer value succeeds.
//   (E) GET reads are UNAFFECTED (scope: this guard is WRITES + the /ws/term socket only).
//   (F) THE v1 GAP, closed: a Tier-1 write (POST /api/questions/:id/answer — the exact class the review
//       flagged as still-open) now ALSO 401s with no credential, and reaches its real handler (404 for a
//       nonexistent id) once the correct secret is presented — proving the guard, not routing, was v1's
//       actual failure.
//   (F2) the anti-fabrication route itself: POST /api/sessions/:id/input (ownerText) — same proof.
//   (H) /ws/term: a loopback upgrade with NO credential is REJECTED before the 101 response; a valid
//       [generic, bearer] subprotocol offer OR a valid `?token=` query fallback is ACCEPTED (reusing the
//       SAME mechanism trust-tier.mjs already proves for the remote case) — with `loopbackSecret` wired.
//   (G) structural: the guard's route-matching no longer references routeTier at all (v2 gates
//       unconditionally) — confirmed by reading the compiled hook body.
//
// v3 (card 351e89af — SECURITY): /ws/companion's inbound message path carried the identical assumption
// v1/v2 deliberately left open — "the loopback cockpit IS the authenticated human, so no auth at all" —
// documented as a known gap in this hook's own v2 doc comment. Unlike the alert-text path (018ce1db), an
// agent with Bash could inject straight into the owner-role Companion slot with NO manager involved at
// all. v3 gates `/ws/companion/:sessionId` by the EXACT same mechanism as /ws/term (no second scheme):
//   (I) a loopback upgrade to /ws/companion with NO credential is REJECTED before the 101 response; a
//       WRONG bearer subprotocol is also rejected; a VALID [generic, bearer] offer OR a valid `?token=`
//       fallback is ACCEPTED — mirroring (H) exactly, proving the SAME mechanism was reused, not a
//       parallel one. (loopbackSecret omitted ⇒ inert, proven alongside (A).)
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const TMP = mkdtempManaged("loom-loopback-guard-");
process.env.LOOM_HOME = TMP;
const PORT = 45418 + (process.pid % 900); // non-4317, low-collision — see gateway-hardening.mjs's own note
process.env.LOOM_PORT = String(PORT);
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { WS_GENERIC_SUBPROTOCOL, WS_BEARER_PREFIX } = await import("../dist/gateway/trust-tier.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const now = new Date().toISOString();
const stub = {};
// /ws/term's handler unconditionally calls `deps.pty.subscribe(sessionId, {...})` on a successful
// upgrade (and its returned unsub on socket close) — a bare `{}` stub would throw the moment an ACCEPT-
// path test (H below) actually connects. trust-tier.mjs's own equivalent test deliberately avoided this
// by only exercising /ws/term's REJECT path (auth happens before the handler ever runs, so a plain `{}`
// stub is fine there) and using /ws/companion for its accept-path proof instead (a handler that
// tolerates a missing dep). This file needs a real accept proof for /ws/term specifically (it's the
// route the Critical named), so it gets a minimal working stub instead.
const ptyStub = { subscribe: () => () => {}, writeStdin: () => {}, repaint: () => {}, resize: () => {} };
// Loopback headers so the CSRF/DNS-rebind onRequest hook lets every request through to the handler —
// mirrors gateway-hardening.mjs exactly (Host/Origin matched by hostname only, port is cosmetic here).
const H = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, "content-type": "application/json" };
const authH = (bearer) => (bearer ? { ...H, authorization: `Bearer ${bearer}` } : H);
const bearerProto = (token) => `${WS_GENERIC_SUBPROTOCOL}, ${WS_BEARER_PREFIX}${token}`;
// `injectWS` (unlike plain `.inject()`) does NOT default `remoteAddress` — an explicit `socket:` override
// is required to simulate a loopback WS upgrade, mirroring trust-tier.mjs's own `socket: remoteSocket`
// pattern for the remote-peer case. See the guard hook's own "TEST NOTE" doc comment in server.ts for how
// this was found (a bare call silently no-ops the guard instead of rejecting — confirmed via debug
// instrumentation, not assumed).
const LOOPBACK_SOCKET = { remoteAddress: "127.0.0.1" };

let appNoSecret, appWithSecret, db;
try {
  db = new Db(path.join(TMP, "loom.db"));
  db.insertProject({ id: "p1", name: "P1", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null });

  // ===================== (A) backward compat: loopbackSecret OMITTED =====================
  appNoSecret = await buildServer({
    db, pty: ptyStub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
    userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
  });
  const unguardedWrite = await appNoSecret.inject({ method: "PATCH", url: "/api/platform/config", headers: H, payload: {} });
  check("(A) loopbackSecret omitted → the guard is inert, a write with NO auth header still succeeds (existing tests stay byte-identical)",
    unguardedWrite.statusCode === 200);
  const unguardedSocket = await appNoSecret.injectWS("/ws/term/sess1", { headers: H, socket: LOOPBACK_SOCKET });
  check("(A) loopbackSecret omitted → /ws/term upgrade with NO credential still succeeds (unaffected)", !!unguardedSocket);
  unguardedSocket.close();
  const unguardedCompanionSocket = await appNoSecret.injectWS("/ws/companion/sess1", { headers: H, socket: LOOPBACK_SOCKET });
  check("(A) loopbackSecret omitted → /ws/companion upgrade with NO credential still succeeds (unaffected)", !!unguardedCompanionSocket);
  unguardedCompanionSocket.close();

  // ===================== (B)-(H) the real guard, wired =====================
  const SECRET = "test-loopback-secret-0123456789abcdef";
  appWithSecret = await buildServer({
    db, pty: ptyStub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
    userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
    loopbackSecret: SECRET,
  });
  const patchConfig = (bearer) => appWithSecret.inject({ method: "PATCH", url: "/api/platform/config", headers: authH(bearer), payload: {} });

  // (B) THE BYPASS: the exact shape of the demonstrated exploit — a same-host request to a human-only
  // config writer with NO credential at all.
  const noAuth = await patchConfig(undefined);
  check("(B) THE BYPASS IS CLOSED: PATCH /api/platform/config with NO Authorization header → 401 (was 200 pre-fix)",
    noAuth.statusCode === 401);

  // (C) a wrong bearer value is rejected too — not merely "any Authorization header present".
  const wrongAuth = await patchConfig("not-the-real-secret");
  check("(C) a WRONG bearer value → 401", wrongAuth.statusCode === 401);

  // (D) POSITIVE CONTROL: the correct secret succeeds — proves the request itself is well-formed and
  // (B)/(C) are genuinely about the auth check, not some unrelated breakage.
  const rightAuth = await patchConfig(SECRET);
  check("(D) POSITIVE CONTROL: the CORRECT bearer value → 200 (same call, only the credential differs)",
    rightAuth.statusCode === 200);

  // (E) reads stay unaffected — this guard is WRITES + /ws/term only.
  const readNoAuth = await appWithSecret.inject({ method: "GET", url: "/api/projects", headers: H });
  check("(E) GET /api/projects with NO auth header still succeeds (guard is write-only by design)",
    readNoAuth.statusCode === 200);

  // (F) THE v1 GAP: a Tier-1 write (trust-tier.ts's own "safe for an authenticated REMOTE human"
  // allowlist — a materially different predicate from "safe from an unauthenticated co-resident agent",
  // which is what v1 conflated) is NOW gated too.
  const tier1NoAuth = await appWithSecret.inject({ method: "POST", url: "/api/questions/does-not-exist/answer", headers: H, payload: { answer: "yes" } });
  check("(F) THE v1 GAP IS CLOSED: POST /api/questions/:id/answer (Tier-1) with NO auth header → 401 (was 404-passthrough pre-v2)",
    tier1NoAuth.statusCode === 401);
  const tier1WithAuth = await appWithSecret.inject({ method: "POST", url: "/api/questions/does-not-exist/answer", headers: authH(SECRET), payload: { answer: "yes" } });
  check("(F) POSITIVE CONTROL: the SAME route with the correct secret reaches the real handler (404 for a nonexistent id, not 401)",
    tier1WithAuth.statusCode === 404);

  // (F2) the specific anti-fabrication route the review named: POST /api/sessions/:id/input feeds
  // `ownerText` (mcp/questionTool.ts) on the premise it comes from an authenticated human composer.
  const ownerTextNoAuth = await appWithSecret.inject({ method: "POST", url: "/api/sessions/does-not-exist/input", headers: H, payload: { text: "hi" } });
  check("(F2) POST /api/sessions/:id/input (ownerText source) with NO auth header → 401",
    ownerTextNoAuth.statusCode === 401);

  // ===================== (H) /ws/term: the stdin-write capability =====================
  const wsNoAuth = await (async () => {
    try { const ws = await appWithSecret.injectWS("/ws/term/sess1", { headers: H, socket: LOOPBACK_SOCKET }); ws.close(); return false; }
    catch { return true; }
  })();
  check("(H) /ws/term upgrade with NO credential → REJECTED before the 101 response (with loopbackSecret wired)", wsNoAuth);

  const wsWrongAuth = await (async () => {
    try { const ws = await appWithSecret.injectWS("/ws/term/sess1", { headers: { ...H, "sec-websocket-protocol": bearerProto("wrong-token") }, socket: LOOPBACK_SOCKET }); ws.close(); return false; }
    catch { return true; }
  })();
  check("(H) /ws/term upgrade with a WRONG bearer subprotocol → REJECTED", wsWrongAuth);

  const wsOkProto = await appWithSecret.injectWS("/ws/term/sess2", { headers: { ...H, "sec-websocket-protocol": bearerProto(SECRET) }, socket: LOOPBACK_SOCKET });
  check("(H) POSITIVE CONTROL: /ws/term upgrade with a VALID [generic, bearer] subprotocol offer → ACCEPTED", !!wsOkProto);
  wsOkProto.close();

  const wsOkQuery = await appWithSecret.injectWS(`/ws/term/sess3?token=${SECRET}`, { headers: H, socket: LOOPBACK_SOCKET });
  check("(H) POSITIVE CONTROL: /ws/term upgrade with a VALID ?token= query fallback → ACCEPTED", !!wsOkQuery);
  wsOkQuery.close();

  // ===================== (I) /ws/companion: the SAME gap, closed by card 351e89af =====================
  const wsCompanionNoAuth = await (async () => {
    try { const ws = await appWithSecret.injectWS("/ws/companion/csess1", { headers: H, socket: LOOPBACK_SOCKET }); ws.close(); return false; }
    catch { return true; }
  })();
  check("(I) THE GAP IS CLOSED: /ws/companion upgrade with NO credential → REJECTED before the 101 response (was ACCEPTED pre-fix)", wsCompanionNoAuth);

  const wsCompanionWrongAuth = await (async () => {
    try { const ws = await appWithSecret.injectWS("/ws/companion/csess1", { headers: { ...H, "sec-websocket-protocol": bearerProto("wrong-token") }, socket: LOOPBACK_SOCKET }); ws.close(); return false; }
    catch { return true; }
  })();
  check("(I) /ws/companion upgrade with a WRONG bearer subprotocol → REJECTED", wsCompanionWrongAuth);

  const wsCompanionOkProto = await appWithSecret.injectWS("/ws/companion/csess2", { headers: { ...H, "sec-websocket-protocol": bearerProto(SECRET) }, socket: LOOPBACK_SOCKET });
  check("(I) POSITIVE CONTROL: /ws/companion upgrade with a VALID [generic, bearer] subprotocol offer → ACCEPTED (proves the mechanism, not just the rejection)", !!wsCompanionOkProto);
  wsCompanionOkProto.close();

  const wsCompanionOkQuery = await appWithSecret.injectWS(`/ws/companion/csess3?token=${SECRET}`, { headers: H, socket: LOOPBACK_SOCKET });
  check("(I) POSITIVE CONTROL: /ws/companion upgrade with a VALID ?token= query fallback → ACCEPTED", !!wsCompanionOkQuery);
  wsCompanionOkQuery.close();

  // (G) structural: v2 no longer consults routeTier at all in the guard (it gates unconditionally) —
  // confirmed by reading the compiled source, mirroring gateway-token.mjs's own (F) pattern.
  {
    const serverPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "dist", "gateway", "server.js");
    const src = fs.readFileSync(serverPath, "utf8");
    const guardIdx = src.indexOf("Loopback human-only-write guard");
    check("(G) the guard block exists in compiled output", guardIdx !== -1);
    const guardSlice = src.slice(guardIdx, guardIdx + 7000);
    check("(G) v2 gates every /api/* write unconditionally — no routeTier check inside the guard hook",
      !/routeTier\(req\.method, routePattern\)/.test(guardSlice.slice(guardSlice.indexOf("app.addHook"))));
    check("(G) the guard also matches the /ws/term upgrade route by pattern",
      /routePattern === ["']\/ws\/term\/:sessionId["']/.test(guardSlice));
    check("(G) v3: the guard also matches the /ws/companion upgrade route by pattern (card 351e89af)",
      /routePattern === ["']\/ws\/companion\/:sessionId["']/.test(guardSlice));
  }
} finally {
  try { await appNoSecret?.close(); } catch { /* ignore */ }
  try { await appWithSecret?.close(); } catch { /* ignore */ }
  db?.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the loopback human-only-write guard (v3) closes the unauthenticated same-host bypass on EVERY non-GET /api/* write, the /ws/term stdin socket, AND the /ws/companion inbound chat socket (card 351e89af) — including the Tier-1 human-authority routes v1 left open (session input's ownerText source, questions/answer) — proven both failing-without and succeeding-with the correct secret, leaves reads unaffected, and stays inert (byte-identical) for every existing partial-stub test that doesn't wire it."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
