// HTTP-layer test for the composer-queue REST surface (the #composer-queue feature) — FULLY HERMETIC:
// no live daemon, no real claude, no bound port. Builds the real Fastify gateway in-process
// (buildServer) against a temp Db + the REAL PtyHost driving a FAKE pty (createPty seam), and drives
// the queue routes via app.inject():
//   • POST   /api/sessions/:id/input            — the HUMAN composer; tags its entry source:'human'
//   • GET    /api/sessions/:id/queue            — returns {id,text,source}[] (the UI view)
//   • PATCH  /api/sessions/:id/queue/:entryId   — edit a HELD entry's text
//   • DELETE /api/sessions/:id/queue/:entryId   — remove a HELD entry
//   • PATCH  /api/sessions/:id/queue            — reorder the human entries
// The trust boundary is the point of the test: a programmatic enqueue (worker report / nudge) is
// 'system' and the mutators REFUSE it → the route maps refused→403, so an agent's queued message can
// never be rewritten or reordered from the human surface. Plus the validation edges: 404 unknown
// session, 400 bad body, and a stale/unknown id is a graceful 200 no-op.
//
// RUN (self-isolating; sets its OWN temp LOOM_HOME before importing dist):
//   1) build the daemon, 2) node test/pty-queue-rest.mjs
import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-queuerest-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(process.env.LOOM_HOME, "logs"), { recursive: true });
requireHermeticEnv(); // confirm LOOM_HOME is the throwaway temp dir, never the real ~/.loom

const LOOM = process.env.LOOM_HOME;

// Import dist AFTER LOOM_HOME is set (paths.ts reads it at module-eval time).
const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { PtyHost } = await import("../dist/pty/host.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ---- temp Db with one LIVE session row (the mutators 404-gate on db.getSession) ----
const db = new Db(path.join(LOOM, "loom.db"));
const now = new Date().toISOString();
db.insertProject({ id: "p", name: "P", repoPath: "p", vaultPath: "p", config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "t", projectId: "p", name: "t", startupPrompt: "x", position: 0 });
const SID = "s";
db.insertSession({ id: SID, projectId: "p", agentId: "t", engineSessionId: null, title: null, cwd: LOOM,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null });

// ---- REAL PtyHost over a FAKE pty (no claude) ----
function makeFakePty() {
  return { pid: 4242, write: () => {}, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), kill: () => {}, resize: () => {} };
}
class TestPtyHost extends PtyHost { createPty() { return makeFakePty(); } }
const host = new TestPtyHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
host.spawn({ sessionId: SID, cwd: LOOM, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
host.deliverHook(SID, { hook_event_name: "SessionStart" }); // mark ready
host.enqueueStdin(SID, "PRIMER"); // idle → delivers now + arms busy, so everything after this QUEUES

const stub = {};
const app = await buildServer({ db, pty: host, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, control: stub, usageStatus: stub });

const getQueue = async () => (await app.inject({ method: "GET", url: `/api/sessions/${SID}/queue` })).json().pending;
const idOf = (q, text) => q.find((e) => e.text === text)?.id;

try {
  // ════════ POST /input — the human composer; queues (busy) and tags source:'human' ════════
  const p1 = await app.inject({ method: "POST", url: `/api/sessions/${SID}/input`, payload: { text: "H1" } });
  check("POST /input: 200, queued (delivered:false, has position)", p1.statusCode === 200 && p1.json().delivered === false && typeof p1.json().position === "number");
  await app.inject({ method: "POST", url: `/api/sessions/${SID}/input`, payload: { text: "H2" } });
  // A PROGRAMMATIC enqueue (worker report) — defaults to 'system', the read-only kind.
  host.enqueueStdin(SID, "WORKER REPORT");

  let q = await getQueue();
  check("GET /queue: returns 3 entries with {id,text,source}", q.length === 3 && q.every((e) => e.id && typeof e.text === "string" && (e.source === "human" || e.source === "system")));
  check("GET /queue: composer entries tagged source:'human'", q[0].text === "H1" && q[0].source === "human" && q[1].source === "human");
  check("GET /queue: programmatic entry tagged source:'system'", idOf(q, "WORKER REPORT") && q.find((e) => e.text === "WORKER REPORT").source === "system");

  const h1 = idOf(q, "H1"), h2 = idOf(q, "H2"), sys = idOf(q, "WORKER REPORT");

  // ════════ PATCH edit a HUMAN entry ════════
  const e1 = await app.inject({ method: "PATCH", url: `/api/sessions/${SID}/queue/${h1}`, payload: { text: "H1-edited" } });
  check("PATCH human edit: 200 {edited:true}", e1.statusCode === 200 && e1.json().edited === true);
  q = await getQueue();
  check("PATCH human edit: text changed in place", q.find((e) => e.id === h1)?.text === "H1-edited");

  // ════════ PATCH reorder human entries; system entry stays pinned ════════
  const r1 = await app.inject({ method: "PATCH", url: `/api/sessions/${SID}/queue`, payload: { orderedIds: [h2, h1] } });
  check("PATCH reorder: 200 {reordered:true}", r1.statusCode === 200 && r1.json().reordered === true);
  q = await getQueue();
  check("PATCH reorder: applied → [H2, H1-edited, WORKER REPORT] (system pinned last)",
    q.map((e) => e.text).join("|") === "H2|H1-edited|WORKER REPORT");

  // ════════ TRUST BOUNDARY: every mutator REFUSES a 'system' entry → 403 ════════
  const eSys = await app.inject({ method: "PATCH", url: `/api/sessions/${SID}/queue/${sys}`, payload: { text: "HACK" } });
  check("PATCH system edit: 403 refused", eSys.statusCode === 403 && eSys.json().refused === true);
  const dSys = await app.inject({ method: "DELETE", url: `/api/sessions/${SID}/queue/${sys}` });
  check("DELETE system: 403 refused", dSys.statusCode === 403 && dSys.json().refused === true);
  const rSys = await app.inject({ method: "PATCH", url: `/api/sessions/${SID}/queue`, payload: { orderedIds: [sys, h2] } });
  check("PATCH reorder naming a system id: 403 refused", rSys.statusCode === 403 && rSys.json().refused === true);
  q = await getQueue();
  check("after refused ops: queue + system text untouched", q.map((e) => e.text).join("|") === "H2|H1-edited|WORKER REPORT");

  // ════════ DELETE a HUMAN entry ════════
  const d1 = await app.inject({ method: "DELETE", url: `/api/sessions/${SID}/queue/${h2}` });
  check("DELETE human: 200 {deleted:true}", d1.statusCode === 200 && d1.json().deleted === true);
  q = await getQueue();
  check("DELETE human: queue is now [H1-edited, WORKER REPORT]", q.map((e) => e.text).join("|") === "H1-edited|WORKER REPORT");

  // ════════ graceful no-op: an unknown/stale id on a real session → 200 {deleted:false} ════════
  const dStale = await app.inject({ method: "DELETE", url: `/api/sessions/${SID}/queue/no-such-id` });
  check("DELETE stale id: 200 {deleted:false} (graceful no-op, not 403/404)", dStale.statusCode === 200 && dStale.json().deleted === false && dStale.json().refused === undefined);

  // ════════ validation edges ════════
  const r404 = await app.inject({ method: "DELETE", url: `/api/sessions/nope/queue/x` });
  check("DELETE unknown session: 404", r404.statusCode === 404);
  const b400 = await app.inject({ method: "PATCH", url: `/api/sessions/${SID}/queue/${h1}`, payload: {} });
  check("PATCH edit w/ no text: 400", b400.statusCode === 400);
  const ro400 = await app.inject({ method: "PATCH", url: `/api/sessions/${SID}/queue`, payload: { orderedIds: "nope" } });
  check("PATCH reorder w/ non-array orderedIds: 400", ro400.statusCode === 400);
} finally {
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
  try { await app.close(); } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(LOOM, { recursive: true, force: true }); break; } catch { /* retry (WAL handle) */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the queue REST surface tags human vs system at enqueue, returns id+text+source, edits/reorders/deletes human entries, REFUSES (403) every mutation of a system entry, and validates 404/400/stale-id edges."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
