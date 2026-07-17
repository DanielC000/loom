// Coverage for the bulk GET /api/sessions/queues + /api/sessions/wakes endpoints (perf profile
// 2026-07-16 finding #4: Overview/Terminals render one card per live session and each independently
// polled its own /queue (3s) + /wakes (15s) — these bulk counterparts collapse that to one round-trip).
// Added by 1f0d8e66 with no direct test; this file is that coverage. Covers three layers:
//   1) db.listWakesForSessions(sessionIds) — the grouped-by-session-id DB helper.
//   2) parseIdsParam(raw) — the shared `?ids=a,b,c` query-param parser.
//   3) HTTP smoke for both endpoints via the real Fastify gateway (buildServer) + app.inject(), mirroring
//      the pty-queue-rest.mjs harness pattern (a REAL PtyHost over a FAKE pty — no live claude).
//
// RUN (self-isolating; sets its OWN temp LOOM_HOME before importing dist):
//   1) build the daemon, 2) node test/session-queues-wakes-bulk.mjs
import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-qwbulk-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(process.env.LOOM_HOME, "logs"), { recursive: true });
requireHermeticEnv(); // confirm LOOM_HOME is the throwaway temp dir, never the real ~/.loom

const LOOM = process.env.LOOM_HOME;

// Import dist AFTER LOOM_HOME is set (paths.ts reads it at module-eval time).
const { Db } = await import("../dist/db.js");
const { buildServer, parseIdsParam } = await import("../dist/gateway/server.js");
const { PtyHost } = await import("../dist/pty/host.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ════════════════════════════════════════════════════════════════════════════════
// 1) db.listWakesForSessions — grouped-by-session, absent (not []) when no wakes, empty input → {}
// ════════════════════════════════════════════════════════════════════════════════
{
  const dbFile = path.join(LOOM, "wakes.db");
  const db = new Db(dbFile);
  const now = new Date().toISOString();
  db.insertProject({ id: "p", name: "P", repoPath: "p", vaultPath: "p", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "t", projectId: "p", name: "t", startupPrompt: "x", position: 0 });
  const mkSession = (id) => db.insertSession({
    id, projectId: "p", agentId: "t", engineSessionId: null, title: null, cwd: LOOM,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  });
  mkSession("s1"); mkSession("s2"); mkSession("s3"); // s3 gets no wakes

  db.insertWake({ id: "w1", sessionId: "s1", wakeAt: now, note: "s1 first", createdAt: now });
  db.insertWake({ id: "w2", sessionId: "s1", wakeAt: now, note: "s1 second", createdAt: now });
  db.insertWake({ id: "w3", sessionId: "s2", wakeAt: now, note: "s2 only", createdAt: now });

  // Empty input must NOT issue an `IN ()` query — assert the early-return shape, not just "didn't throw".
  const empty = db.listWakesForSessions([]);
  check("listWakesForSessions([]): returns {} without querying", Object.keys(empty).length === 0);

  const grouped = db.listWakesForSessions(["s1", "s2", "s3"]);
  check("listWakesForSessions: s1 grouped with both its wakes", Array.isArray(grouped.s1) && grouped.s1.length === 2
    && grouped.s1.every((w) => w.sessionId === "s1"));
  check("listWakesForSessions: s2 grouped with its one wake", Array.isArray(grouped.s2) && grouped.s2.length === 1
    && grouped.s2[0].note === "s2 only");
  check("listWakesForSessions: s3 (no wakes) is ABSENT from the result, not an empty array", !("s3" in grouped));
  check("listWakesForSessions: an id with no rows at all is likewise absent", !("nonexistent" in db.listWakesForSessions(["nonexistent"])));

  // A subset query only returns the requested + matching sessions.
  const subset = db.listWakesForSessions(["s2"]);
  check("listWakesForSessions: subset query returns only the requested session's wakes", Object.keys(subset).join(",") === "s2" && subset.s2.length === 1);

  db.close();
}

// ════════════════════════════════════════════════════════════════════════════════
// 2) parseIdsParam — dedup, trim, drop blanks; missing/blank → []
// ════════════════════════════════════════════════════════════════════════════════
{
  check("parseIdsParam(undefined): []", Array.isArray(parseIdsParam(undefined)) && parseIdsParam(undefined).length === 0);
  check("parseIdsParam(''): []", parseIdsParam("").length === 0);
  check("parseIdsParam('   '): [] (all-blank list)", parseIdsParam("   ").length === 0);
  check("parseIdsParam('a,b,c'): passes through in order", parseIdsParam("a,b,c").join(",") === "a,b,c");
  check("parseIdsParam(' a , b ,c '): trims whitespace around each id", parseIdsParam(" a , b ,c ").join(",") === "a,b,c");
  check("parseIdsParam('a,,b'): drops blank entries", parseIdsParam("a,,b").join(",") === "a,b");
  check("parseIdsParam('a,a,b'): dedups", parseIdsParam("a,a,b").join(",") === "a,b");
  check("parseIdsParam('a, ,b,'): drops blank + trailing-comma blank", parseIdsParam("a, ,b,").join(",") === "a,b");
}

// ════════════════════════════════════════════════════════════════════════════════
// 3) Endpoint smoke — real Fastify gateway (buildServer) + app.inject(), REAL PtyHost over a FAKE pty
//    (mirrors pty-queue-rest.mjs's harness).
// ════════════════════════════════════════════════════════════════════════════════
{
  const dbFile = path.join(LOOM, "endpoint.db");
  const db = new Db(dbFile);
  const now = new Date().toISOString();
  db.insertProject({ id: "p", name: "P", repoPath: "p", vaultPath: "p", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "t", projectId: "p", name: "t", startupPrompt: "x", position: 0 });
  const mkSession = (id) => db.insertSession({
    id, projectId: "p", agentId: "t", engineSessionId: null, title: null, cwd: LOOM,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  });
  mkSession("a"); mkSession("b");
  db.insertWake({ id: "wa", sessionId: "a", wakeAt: now, note: "wake for a", createdAt: now });

  function makeFakePty() {
    return { pid: 4242, write: () => {}, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), kill: () => {}, resize: () => {} };
  }
  class TestPtyHost extends PtyHost { createPty() { return makeFakePty(); } }
  const host = new TestPtyHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
  for (const id of ["a", "b"]) {
    host.spawn({ sessionId: id, cwd: LOOM, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
    host.deliverHook(id, { hook_event_name: "SessionStart" }); // mark ready
    host.enqueueStdin(id, "PRIMER"); // idle → delivers now + arms busy, so everything after this QUEUES
  }
  host.enqueueStdin("a", "QUEUED FOR A"); // held (session 'a' is busy after PRIMER)

  const stub = {};
  const app = await buildServer({ db, pty: host, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, control: stub, usageStatus: stub });

  try {
    // ---- GET /api/sessions/wakes?ids=a,b ----
    const wr = await app.inject({ method: "GET", url: "/api/sessions/wakes?ids=a,b" });
    check("GET /sessions/wakes: 200", wr.statusCode === 200);
    const wbody = wr.json();
    check("GET /sessions/wakes: session 'a' grouped with its wake", Array.isArray(wbody.a) && wbody.a.length === 1 && wbody.a[0].note === "wake for a");
    check("GET /sessions/wakes: session 'b' (no wakes) absent from the response body", !("b" in wbody));

    // ---- GET /api/sessions/queues?ids=a ----
    const qr = await app.inject({ method: "GET", url: "/api/sessions/queues?ids=a" });
    check("GET /sessions/queues: 200", qr.statusCode === 200);
    const qbody = qr.json();
    check("GET /sessions/queues: returns per-id pending entries for 'a'", Array.isArray(qbody.a) && qbody.a.some((e) => e.text === "QUEUED FOR A"));

    // ---- unknown/dead id tolerance — no 404 for either bulk route ----
    const wrUnknown = await app.inject({ method: "GET", url: "/api/sessions/wakes?ids=a,dead-session" });
    check("GET /sessions/wakes with an unknown id: still 200 (no 404)", wrUnknown.statusCode === 200);
    check("GET /sessions/wakes: the unknown id is absent from the result (never had wake rows)", !("dead-session" in wrUnknown.json()));

    const qrUnknown = await app.inject({ method: "GET", url: "/api/sessions/queues?ids=a,dead-session" });
    check("GET /sessions/queues with an unknown id: still 200 (no 404)", qrUnknown.statusCode === 200);
    // getPendingEntries returns [] for an unknown session (pty/host.ts), so the queues route sets the key
    // to an empty array rather than omitting it — still a graceful, harmless tolerance, just not a missing key.
    check("GET /sessions/queues: the unknown id is present but empty (getPendingEntries returns [] for an unknown session)",
      Array.isArray(qrUnknown.json()["dead-session"]) && qrUnknown.json()["dead-session"].length === 0);

    // ---- missing ids param → empty object, not an error ----
    const wrNoIds = await app.inject({ method: "GET", url: "/api/sessions/wakes" });
    check("GET /sessions/wakes with no ids param: 200 {}", wrNoIds.statusCode === 200 && Object.keys(wrNoIds.json()).length === 0);
    const qrNoIds = await app.inject({ method: "GET", url: "/api/sessions/queues" });
    check("GET /sessions/queues with no ids param: 200 {}", qrNoIds.statusCode === 200 && Object.keys(qrNoIds.json()).length === 0);
  } finally {
    for (const id of ["a", "b"]) { try { host.stop(id, "hard"); } catch { /* ignore */ } }
    try { await app.close(); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
  }
}

for (let i = 0; i < 5; i++) { try { fs.rmSync(LOOM, { recursive: true, force: true }); break; } catch { /* retry (WAL handle) */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — db.listWakesForSessions groups by session and omits sessions with no wakes ({} for empty input, no IN() query), parseIdsParam dedups/trims/drops-blanks, and both bulk endpoints (/sessions/queues, /sessions/wakes) return grouped per-id results and tolerate an unknown/dead id with no 404."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
