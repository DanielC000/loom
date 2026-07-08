// Decision-inbox READ side test (card 8701bdbb, child B). HERMETIC like all-archived-sessions.mjs: no
// real claude — drives the built Db + the REAL buildServer via app.inject against a throwaway SQLite Db
// in an isolated LOOM_HOME. Covers the new read surface child B adds on top of child A's questions core:
//   A. db.listOpenQuestions() spans ALL projects/sessions, enriched with agentName/projectName/sessionLive.
//   B. it EXCLUDES 'consumed' by default; `includeConsumed=true` folds it in. Newest-first.
//   C. GET /api/questions mirrors that (+ the ?includeConsumed=true query param).
//   D. GET /api/questions/:id returns one enriched question; 404 on an unknown id.
//   E. the full round-trip: an answer (via the EXISTING answer route) flips pending→answered and the
//      answered row surfaces via the reads carrying chosenOption/note.
// Run: 1) build the daemon, 2) node test/questions-inbox-read.mjs
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-questions-inbox-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
requireHermeticEnv(); // confirm LOOM_HOME is the throwaway temp dir, never the real ~/.loom

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const now = new Date().toISOString();
const at = (ms) => new Date(Date.parse("2026-07-08T00:00:00.000Z") + ms).toISOString();
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

  // Two projects, each with one manager agent + a live asking session.
  db.insertProject({ id: "pA", name: "Alpha", repoPath: "C:/tmp/a", vaultPath: "C:/tmp/a", config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: "pB", name: "Beta", repoPath: "C:/tmp/b", vaultPath: "C:/tmp/b", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "aA", projectId: "pA", name: "Alpha Lead", startupPrompt: "", position: 0 });
  db.insertAgent({ id: "aB", projectId: "pB", name: "Beta Lead", startupPrompt: "", position: 0 });
  db.insertSession(mkSession("sA", "pA", "aA")); // live
  db.insertSession(mkSession("sB", "pB", "aB", { processState: "exited" })); // asking session gone

  // Questions across both projects, in different states + created instants (for the DESC ordering).
  db.insertQuestion(mkQuestion("q1", "sA", "pA", { createdAt: at(1000), options: ["A", "B"], recommendation: "B" }));  // pending, options
  db.insertQuestion(mkQuestion("q2", "sB", "pB", { createdAt: at(3000) }));  // pending, pure-blocker (no options)
  db.insertQuestion(mkQuestion("q3", "sA", "pA", { createdAt: at(2000), state: "answered", chosenOption: "A", note: "go A", answeredAt: at(2500) }));  // answered
  db.insertQuestion(mkQuestion("q4", "sA", "pA", { createdAt: at(500), state: "consumed", chosenOption: "A", note: "old", answeredAt: at(600), consumedAt: at(700) }));  // consumed

  // --- A. spans all projects, enriched ------------------------------------------------------------
  const open = db.listOpenQuestions();
  check("A: listOpenQuestions spans both projects", open.some((q) => q.projectId === "pA") && open.some((q) => q.projectId === "pB"));
  const q1 = open.find((q) => q.id === "q1");
  check("A: enriched with agentName (via session→agent join)", q1.agentName === "Alpha Lead");
  check("A: enriched with projectName", q1.projectName === "Alpha");
  check("A: sessionLive true for a live asking session", q1.sessionLive === true);
  const q2 = open.find((q) => q.id === "q2");
  check("A: sessionLive false for an exited asking session", q2 && q2.sessionLive === false);
  check("A: options + recommendation round-trip", Array.isArray(q1.options) && q1.options.join(",") === "A,B" && q1.recommendation === "B");

  // --- B. excludes consumed by default; newest-first; includeConsumed folds it in ------------------
  check("B: 'consumed' q4 EXCLUDED by default", open.every((q) => q.id !== "q4"));
  check("B: default returns exactly the 3 pending+answered", open.length === 3);
  check("B: newest-first (q2 → q3 → q1 by createdAt DESC)", open.map((q) => q.id).join(",") === "q2,q3,q1");
  const withConsumed = db.listOpenQuestions(true);
  check("B: includeConsumed folds in q4", withConsumed.some((q) => q.id === "q4") && withConsumed.length === 4);

  // --- getQuestionInboxItem single fetch ----------------------------------------------------------
  check("getQuestionInboxItem returns the enriched row", db.getQuestionInboxItem("q3").agentName === "Alpha Lead");
  check("getQuestionInboxItem returns undefined for unknown id", db.getQuestionInboxItem("nope") === undefined);

  // --- C + D + E via the REAL HTTP routes ---------------------------------------------------------
  const pushed = [];
  const ptyStub = { enqueueStdin: (...a) => { pushed.push(a); return { delivered: false, reason: "session-dead" }; } };
  const stub = {};
  const app = await buildServer({ db, pty: ptyStub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

  const getList = await app.inject({ method: "GET", url: "/api/questions" });
  check("C: GET /api/questions → 200", getList.statusCode === 200);
  const listBody = getList.json();
  check("C: GET /api/questions excludes consumed (3 rows)", listBody.length === 3 && listBody.every((q) => q.state !== "consumed"));
  const getListAll = await app.inject({ method: "GET", url: "/api/questions?includeConsumed=true" });
  check("C: GET /api/questions?includeConsumed=true → 4 rows", getListAll.json().length === 4);

  const getOne = await app.inject({ method: "GET", url: "/api/questions/q1" });
  check("D: GET /api/questions/:id → 200 with enriched fields", getOne.statusCode === 200 && getOne.json().projectName === "Alpha");
  const getUnknown = await app.inject({ method: "GET", url: "/api/questions/nope" });
  check("D: GET /api/questions/:id → 404 unknown", getUnknown.statusCode === 404);

  // E. answer q1 (options question) via the EXISTING answer route, then re-read.
  const answer = await app.inject({ method: "POST", url: "/api/questions/q1/answer", payload: { chosenOption: "B", note: "ship it" } });
  check("E: POST answer → 200", answer.statusCode === 200 && answer.json().state === "answered");
  const afterList = await app.inject({ method: "GET", url: "/api/questions" });
  const q1After = afterList.json().find((q) => q.id === "q1");
  check("E: answered q1 still lists, now carrying chosenOption/note", q1After && q1After.state === "answered" && q1After.chosenOption === "B" && q1After.note === "ship it");
  check("E: answer route best-effort-nudged the asking manager pty", pushed.length === 1 && pushed[0][0] === "sA");
  // pure-blocker (no options) requires a non-empty note — mirror the route's 400.
  const badBlocker = await app.inject({ method: "POST", url: "/api/questions/q2/answer", payload: { note: "" } });
  check("E: pure-blocker with empty note → 400", badBlocker.statusCode === 400);
  const goodBlocker = await app.inject({ method: "POST", url: "/api/questions/q2/answer", payload: { note: "open a PR instead" } });
  check("E: pure-blocker with a note → 200 answered (chosenOption stays null)", goodBlocker.statusCode === 200 && goodBlocker.json().chosenOption === null);

  await app.close();
  db.close();
} finally {
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — decision-inbox reads span all projects, exclude consumed by default, enrich display fields; GET routes + answer round-trip work."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
