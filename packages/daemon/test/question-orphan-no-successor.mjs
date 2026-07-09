import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Residual-gap regression (card 8701bdbb follow-up): what happens to a decision-inbox question when its
// asking manager is gone WITHOUT a successor — never recycled, so db.reparentQuestions never runs.
//
// (1) exited but RESUMABLE (or 'unknown' — never yet attempted) → NOT orphaned. A later resume brings the
//     SAME session id back live; the answered-stuck watchdog + question_pull pick it up from there. This
//     is the already-working case — proves listOpenQuestions/getQuestionInboxItem don't over-flag it.
// (2) resumability flipped to 'dead' (a resume attempt already proved the engine transcript/worktree
//     gone — sessions/service.ts resume()) → ORPHANED. No future resume will ever revive this exact
//     session id, so question_pull can never fire for it again — THIS is the real stranding case: before
//     this fix, the web attention queue (useAttention) filtered a pending question purely on
//     `state === "pending"`, so it surfaced as an indistinguishable, permanently-actionable "DECISION
//     NEEDED" forever. answering it silently does nothing (POST /answer persists the note, but
//     tickAnsweredStuckQuestions only ever nudges a LIVE manager, and this session can never become
//     live again). This test proves the `sessionOrphaned` derived field the UI fix branches on.
//
// A THIRD hypothesized end-state — the session row itself hard-deleted while a question still points at
// it — turned out NOT to be reachable: `questions.session_id` is a NOT NULL FK, and better-sqlite3
// enforces foreign keys by default (verified below), so deleting a session/agent/project that ever asked
// a question used to THROW a raw SQLITE_CONSTRAINT_FOREIGNKEY instead of succeeding — a real, previously-
// unknown bug this investigation surfaced (deleteSession/deleteAgent/deleteProject cleaned up wakes +
// companion_reminders per session but never questions). Fixed alongside sessionOrphaned: all three now
// cascade-delete a session's questions too, so a dangling `questions` row can never exist and the delete
// itself no longer crashes.
//
// Run: 1) build (turbo builds shared first), 2) node test/question-orphan-no-successor.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Db } from "../dist/db.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Sanity-check the load-bearing premise itself: this better-sqlite3 build enforces FKs by default (the
// stale comment at db.ts's old deleteProject doc claimed otherwise — verify, don't trust it).
check("better-sqlite3 enforces foreign_keys by default in this build (the premise for the delete-cascade fix)",
  new Database(":memory:").pragma("foreign_keys", { simple: true }) === 1);

const tmpHome = path.join(os.tmpdir(), `loom-q-orphan-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const dbFile = path.join(tmpHome, "qo.db");
const db = new Db(dbFile);
const now = new Date().toISOString();
const projId = "qo-proj", agentId = "qo-agent";

try {
  db.insertProject({ id: projId, name: "QO", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "Manager", startupPrompt: "BRIEF", position: 0 });

  // --- (1) exited-but-resumable manager: NOT orphaned ---
  const resumableId = "qo-mgr-resumable";
  db.insertSession({
    id: resumableId, projectId: projId, agentId, engineSessionId: "eng-resumable", title: null, cwd: projId,
    processState: "exited", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
  const qResumable = "q-resumable";
  db.insertQuestion({
    id: qResumable, sessionId: resumableId, projectId: projId, title: "Ship it?", body: "gate green",
    options: null, recommendation: null, state: "pending", chosenOption: null, note: null,
    createdAt: now, answeredAt: null, consumedAt: null,
  });

  // --- (2) resumability confirmed 'dead' (a resume attempt already proved it unresumable): ORPHANED ---
  const deadId = "qo-mgr-dead";
  db.insertSession({
    id: deadId, projectId: projId, agentId, engineSessionId: "eng-dead", title: null, cwd: projId,
    processState: "exited", resumability: "dead", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
  const qDead = "q-dead";
  db.insertQuestion({
    id: qDead, sessionId: deadId, projectId: projId, title: "Approve the migration?", body: "one-way door",
    options: ["yes", "no"], recommendation: "yes", state: "pending", chosenOption: null, note: null,
    createdAt: now, answeredAt: null, consumedAt: null,
  });

  const items = db.listOpenQuestions();
  const byId = Object.fromEntries(items.map((q) => [q.id, q]));

  check("(1) exited-but-resumable: sessionLive is false (not currently live)", byId[qResumable].sessionLive === false);
  check("(1) exited-but-resumable: sessionOrphaned is false — a later resume recovers it", byId[qResumable].sessionOrphaned === false);

  check("(2) resumability 'dead': sessionLive is false", byId[qDead].sessionLive === false);
  check("(2) resumability 'dead': sessionOrphaned is true — no resume will ever revive this session id", byId[qDead].sessionOrphaned === true);

  // getQuestionInboxItem (the answer-page single-item read) must agree with the list read.
  check("getQuestionInboxItem agrees with listOpenQuestions for the dead case", db.getQuestionInboxItem(qDead).sessionOrphaned === true);
  check("getQuestionInboxItem agrees with listOpenQuestions for the resumable case", db.getQuestionInboxItem(qResumable).sessionOrphaned === false);

  // --- (3) deleteSession with an existing (pending) question must SUCCEED, not throw, and must not
  // leave a dangling `questions` row behind (the FK makes a survivor here structurally impossible, but
  // assert it directly rather than trusting the constraint alone). ---
  let threw = null;
  try { db.deleteSession(deadId); } catch (e) { threw = e; }
  check("(3) deleteSession no longer throws when the session has a pending question (was SQLITE_CONSTRAINT_FOREIGNKEY)", threw === null);
  check("(3) the question is gone WITH the session (cascade-deleted, not left dangling)", db.getQuestion(qDead) === undefined);

  // --- (4) same regression for deleteProject's per-session cascade (a project-wide delete with ANY
  // question anywhere in it used to abort the whole transaction). ---
  const proj2 = "qo-proj2";
  db.insertProject({ id: proj2, name: "QO2", repoPath: proj2, vaultPath: proj2, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "qo-agent2", projectId: proj2, name: "Manager2", startupPrompt: "BRIEF", position: 0 });
  db.insertSession({
    id: "qo-mgr2", projectId: proj2, agentId: "qo-agent2", engineSessionId: "eng2", title: null, cwd: proj2,
    processState: "exited", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
  db.insertQuestion({
    id: "q-in-proj2", sessionId: "qo-mgr2", projectId: proj2, title: "Deploy?", body: "",
    options: null, recommendation: null, state: "pending", chosenOption: null, note: null,
    createdAt: now, answeredAt: null, consumedAt: null,
  });
  let threwProj = null;
  try { db.deleteProject(proj2); } catch (e) { threwProj = e; }
  check("(4) deleteProject no longer throws when one of its sessions has a pending question", threwProj === null);
  check("(4) the project row is actually gone (delete completed, not silently rolled back)", db.getProject(proj2) === undefined);
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — sessionOrphaned distinguishes a question whose asker is gone FOR GOOD (resumability 'dead') from one that's merely not live right now (exited-but-resumable, which a later resume + the answered-stuck watchdog / question_pull still recover) — the signal the web attention queue (useAttention) branches on to stop showing a permanently-actionable 'DECISION NEEDED' for a question nobody will ever pull. Also regression-tests a related bug this investigation surfaced: deleteSession/deleteProject used to throw SQLITE_CONSTRAINT_FOREIGNKEY instead of succeeding whenever the target had ever asked a question, since `questions` was never cascaded alongside wakes/companion_reminders."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
