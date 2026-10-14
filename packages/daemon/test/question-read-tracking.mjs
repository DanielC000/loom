// Phase 2 of card 59fa6403 (Inbox read/unread). HERMETIC like questions-inbox-read.mjs: no real claude,
// drives the built Db + the REAL buildServer via app.inject against a throwaway SQLite Db in an isolated
// LOOM_HOME. Covers:
//   A. db.markQuestionsRead stamps read_at on every id passed, batched in one call.
//   B. it is idempotent — an already-read row's read_at is NEVER overwritten by a later call (first-read
//      time, not last-marked time), and reports only the ids it ACTUALLY updated.
//   C. it is orthogonal to `state`/`acknowledgedUntil` — marking a row read never touches either, and
//      works identically on a pending, answered, or self-terminal `notice` row.
//   D. POST /api/questions/mark-read (the human-only loopback write) round-trips through the real route:
//      200 + {updated:[...]}, a subsequent GET /api/questions carries the stamp, and the route 400s on a
//      missing/malformed `ids` body rather than silently no-opping.
// Run: 1) build the daemon, 2) node test/question-read-tracking.mjs
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-q-readtracking-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
requireHermeticEnv(); // confirm LOOM_HOME is the throwaway temp dir, never the real ~/.loom

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const now = new Date().toISOString();
const mkSession = (id, projectId, agentId, over = {}) => ({
  id, projectId, agentId, engineSessionId: null, title: null, cwd: "C:/tmp/loom-q",
  processState: "live", resumability: "resumable", busy: false, role: "manager",
  createdAt: now, lastActivity: now, lastError: null, ...over,
});
const mkQuestion = (id, sessionId, projectId, over = {}) => ({
  id, sessionId, projectId, title: `Q ${id}`, body: `body ${id}`,
  options: null, recommendation: null, state: "pending",
  chosenOption: null, note: null, createdAt: now, answeredAt: null, consumedAt: null, ...over,
});

try {
  const dbFile = path.join(process.env.LOOM_HOME, "loom.db");
  const db = new Db(dbFile);

  db.insertProject({ id: "pA", name: "Alpha", repoPath: "C:/tmp/a", vaultPath: "C:/tmp/a", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "aA", projectId: "pA", name: "Alpha Lead", startupPrompt: "", position: 0 });
  db.insertSession(mkSession("sA", "pA", "aA"));

  db.insertQuestion(mkQuestion("q1", "sA", "pA")); // pending, unread
  db.insertQuestion(mkQuestion("q2", "sA", "pA", { state: "answered", chosenOption: "A", answeredAt: now })); // answered, unread
  db.insertQuestion(mkQuestion("q3", "sA", "pA", { state: "notice", answeredAt: now, chosenOption: null, options: null, recommendation: null }));  // self-terminal, unread

  // --- A. batched stamp ------------------------------------------------------------------------------
  const readAt = "2026-04-01T00:00:00.000Z";
  const updated = db.markQuestionsRead(["q1", "q2"], readAt);
  check("A: markQuestionsRead batches a list in ONE call", updated.length === 2 && updated.includes("q1") && updated.includes("q2"));
  check("A: q1 reads readAt via getQuestion", db.getQuestion("q1")?.readAt === readAt);
  check("A: q2 reads readAt via getQuestion", db.getQuestion("q2")?.readAt === readAt);
  check("A: q3 (never marked) still reads readAt:null", db.getQuestion("q3")?.readAt === null);

  // --- B. idempotent — never re-stamped, reports only what it actually changed ------------------------
  const laterAt = "2026-05-01T00:00:00.000Z";
  const updated2 = db.markQuestionsRead(["q1", "q3"], laterAt); // q1 already read, q3 not yet
  check("B: a mixed batch reports ONLY the row that was actually unread", updated2.length === 1 && updated2[0] === "q3");
  check("B: q1's read_at is PINNED to its first stamp, never overwritten", db.getQuestion("q1")?.readAt === readAt);
  check("B: q3 is now stamped with the later instant (it was genuinely unread)", db.getQuestion("q3")?.readAt === laterAt);

  // --- C. orthogonal to state/acknowledgedUntil ---------------------------------------------------
  check("C: marking q2 read never touched its state (still 'answered')", db.getQuestion("q2")?.state === "answered");
  check("C: marking q2 read never touched chosenOption", db.getQuestion("q2")?.chosenOption === "A");
  check("C: marking q3 (a notice) read never touched its state (still 'notice')", db.getQuestion("q3")?.state === "notice");
  const ackThenRead = db.acknowledgeQuestion("q2", "2099-01-01T00:00:00.000Z");
  check("C: (setup) q2 snoozed via acknowledgeQuestion", ackThenRead?.acknowledgedUntil === "2099-01-01T00:00:00.000Z");
  check("C: re-marking q2 read (no-op, already read) leaves acknowledgedUntil untouched", db.markQuestionsRead(["q2"], "2026-06-01T00:00:00.000Z").length === 0 && db.getQuestion("q2")?.acknowledgedUntil === "2099-01-01T00:00:00.000Z");

  // --- D. POST /api/questions/mark-read via the REAL HTTP route ---------------------------------------
  db.insertQuestion(mkQuestion("q4", "sA", "pA")); // fresh, unread
  const stub = {};
  const app = await buildServer({ db, pty: { enqueueStdin: () => ({ delivered: false, reason: "n/a" }) }, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

  const resp = await app.inject({ method: "POST", url: "/api/questions/mark-read", payload: { ids: ["q4"] } });
  check("D: POST /api/questions/mark-read → 200", resp.statusCode === 200);
  check("D: response names the id it actually updated", JSON.stringify(resp.json().updated) === JSON.stringify(["q4"]));
  const afterGet = await app.inject({ method: "GET", url: "/api/questions" });
  const q4After = afterGet.json().find((q) => q.id === "q4");
  check("D: a subsequent GET /api/questions carries the stamp", typeof q4After?.readAt === "string" && q4After.readAt.length > 0);

  const respAgain = await app.inject({ method: "POST", url: "/api/questions/mark-read", payload: { ids: ["q4"] } });
  check("D: re-POSTing an already-read id → 200 with an empty updated list (no-op, not an error)", respAgain.statusCode === 200 && respAgain.json().updated.length === 0);

  const badMissing = await app.inject({ method: "POST", url: "/api/questions/mark-read", payload: {} });
  check("D: missing ids → 400", badMissing.statusCode === 400);
  const badType = await app.inject({ method: "POST", url: "/api/questions/mark-read", payload: { ids: "q4" } });
  check("D: non-array ids → 400", badType.statusCode === 400);
  const badElement = await app.inject({ method: "POST", url: "/api/questions/mark-read", payload: { ids: [123] } });
  check("D: non-string element in ids → 400", badElement.statusCode === 400);
  const unknownId = await app.inject({ method: "POST", url: "/api/questions/mark-read", payload: { ids: ["does-not-exist"] } });
  check("D: an unknown id is silently skipped (200, empty updated) — not a 404", unknownId.statusCode === 200 && unknownId.json().updated.length === 0);

  await app.close();
  db.close();
} finally {
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — markQuestionsRead batches + idempotently stamps read_at, orthogonal to state/" +
    "acknowledgedUntil, and POST /api/questions/mark-read round-trips through the real route with correct " +
    "400s on a malformed body."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
