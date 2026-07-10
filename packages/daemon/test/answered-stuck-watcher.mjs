import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Answered-stuck-question watchdog (follow-up to card 8701bdbb — the manager→human decision inbox).
// HERMETIC unit test on IdleWatcher.tickAnsweredStuckQuestions: a RECORDING STUB pty/control, no daemon,
// no real claude — same shape as idle-watcher.mjs. Covers the DoD:
//   (1) a stuck 'answered' question (past the threshold) with a live, unpaused, watching manager →
//       exactly ONE enqueue, kind:"agent", naming question_pull.
//   (2) a second tick on the SAME still-answered question → NO second enqueue (storm guard).
//   (3) a rate-limited (parked) asking manager → no enqueue.
//   (4) a human-paused asking manager → no enqueue.
//   (4b) the asking session is a NON-manager (worker) or has exited → no enqueue (role-scope guard).
//   (5) an asking manager that has itself flagged non-'watching' (idle_report waiting/suppressed) →
//       no enqueue.
//   (6) a 'pending' question → no enqueue. A 'consumed' question → no enqueue.
//   (7) an 'answered' question still under the stuck threshold → no enqueue (not yet).
//   (8) after a question is pulled/consumed, a DIFFERENT stuck question for the SAME manager still
//       nudges independently (the storm guard tracks per-question, not per-manager).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { IdleWatcher } from "../dist/orchestration/idle-watcher.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const NOW = new Date("2026-07-08T12:00:00.000Z");
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();

function makeEnv() {
  const dbFile = path.join(os.tmpdir(), `loom-answered-stuck-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `asp-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `asa-${Math.random().toString(36).slice(2, 8)}`;
  const now = NOW.toISOString();
  db.insertProject({ id: projId, name: "AnsweredStuck", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });

  const alive = new Set();
  const enqueued = [];
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text, source, onDeliver, route, kind) => {
      enqueued.push({ id, text, source, kind });
      return { delivered: true };
    },
  };
  const control = new OrchestrationControl();
  // idle-worker coverage isn't under test here — stub it out cheaply (mirrors idle-watcher.mjs's own
  // unit-level double for these two, never the real SessionService reconciliation).
  const watcher = new IdleWatcher({
    db, pty, control, recycleRatio: 0,
    notifyIdleWorker: () => {},
    isWorkerStranded: () => true,
  });
  return { dbFile, db, projId, agentId, alive, enqueued, control, watcher };
}

function seedManager(e, id, { idleMin = 5, rateLimitedUntil = null, live = true, role = "manager" } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: live ? "live" : "exited", resumability: "resumable", busy: false,
    createdAt: minutesAgo(idleMin), lastActivity: minutesAgo(idleMin), lastError: null, role,
    ctxInputTokens: null, ctxTurns: null, model: null, rateLimitedUntil,
  });
  if (live) e.alive.add(id);
}
let qn = 0;
function seedQuestion(e, sessionId, { state = "answered", answeredMinutesAgo = 30, title } = {}) {
  const id = `q-${++qn}-${Math.random().toString(36).slice(2, 6)}`;
  e.db.insertQuestion({
    id, sessionId, projectId: e.projId, title: title ?? `decision ${id}`, body: "please advise",
    options: null, recommendation: null, state,
    chosenOption: null, note: state === "answered" || state === "consumed" ? "go ahead" : null,
    createdAt: minutesAgo(answeredMinutesAgo + 5),
    answeredAt: state === "pending" ? null : minutesAgo(answeredMinutesAgo),
    consumedAt: state === "consumed" ? minutesAgo(Math.max(answeredMinutesAgo - 1, 0)) : null,
  });
  return id;
}
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ============ (1) stuck answered question + live/unpaused/watching manager → exactly one enqueue ============
{
  const e = makeEnv();
  seedManager(e, "mgr-1");
  const qid = seedQuestion(e, "mgr-1", { answeredMinutesAgo: 30, title: "ship it?" }); // 30m > 15m threshold
  e.watcher.tick(NOW);
  const hits = e.enqueued.filter((x) => x.id === "mgr-1");
  check("(1) exactly one enqueue for the stuck question's asking manager", hits.length === 1);
  check("(1) the nudge is kind:'agent' (one-per-turn, not coalesced)", hits[0]?.kind === "agent");
  check("(1) the nudge names question_pull", /question_pull/.test(hits[0]?.text ?? ""));
  check("(1) the nudge names the question's title", (hits[0]?.text ?? "").includes("ship it?"));
  void qid;
  cleanup(e);
}

// ============ (2) a second tick on the SAME still-answered question → NO second enqueue (storm guard) ============
{
  const e = makeEnv();
  seedManager(e, "mgr-2");
  seedQuestion(e, "mgr-2", { answeredMinutesAgo: 30 });
  e.watcher.tick(NOW);
  e.watcher.tick(NOW);
  e.watcher.tick(NOW);
  const hits = e.enqueued.filter((x) => x.id === "mgr-2");
  check("(2) three ticks on the same stuck question → still exactly ONE enqueue (no storm)", hits.length === 1);
  cleanup(e);
}

// ============ (3) rate-limited (parked) asking manager → no enqueue ============
{
  const e = makeEnv();
  seedManager(e, "mgr-3", { rateLimitedUntil: new Date(NOW.getTime() + 3 * 24 * 60 * 60_000).toISOString() }); // capped 3d out
  seedQuestion(e, "mgr-3", { answeredMinutesAgo: 30 });
  e.watcher.tick(NOW);
  check("(3) a rate-limited/parked manager draws NO nudge (it'll auto-resume)", !e.enqueued.some((x) => x.id === "mgr-3"));
  cleanup(e);
}

// ============ (4) human-paused asking manager → no enqueue ============
{
  const e = makeEnv();
  seedManager(e, "mgr-4");
  seedQuestion(e, "mgr-4", { answeredMinutesAgo: 30 });
  e.control.pause("mgr-4");
  e.watcher.tick(NOW);
  check("(4) a human-paused manager draws NO nudge", !e.enqueued.some((x) => x.id === "mgr-4"));
  cleanup(e);
}

// ============ (4b) role-scope guard: the asking session is a NON-manager, or has exited → no enqueue ============
// (A hard-deleted asking session isn't separately exercised here: the `questions` table's FK on
// session_id makes that state unreachable through the Db's own write surface — deleteSession itself
// refuses while a question row still references it. The `!m` check in the watcher is defensive for that
// unreachable-in-practice case; the two reachable role-scope risks are covered below.)
{
  const e = makeEnv();
  seedManager(e, "wkr-4b", { role: "worker" }); // live, but a WORKER, not a manager
  seedQuestion(e, "wkr-4b", { answeredMinutesAgo: 30 });
  e.watcher.tick(NOW);
  check("(4b) an answered question whose asking session is a WORKER (not a manager) draws NO nudge",
    !e.enqueued.some((x) => x.id === "wkr-4b"));

  const e2 = makeEnv();
  seedManager(e2, "mgr-4b-exited", { live: false }); // manager role, but exited (not live)
  seedQuestion(e2, "mgr-4b-exited", { answeredMinutesAgo: 30 });
  e2.watcher.tick(NOW);
  check("(4b) an answered question whose asking manager has EXITED draws NO nudge",
    !e2.enqueued.some((x) => x.id === "mgr-4b-exited"));
  cleanup(e); cleanup(e2);
}

// ============ (5) manager flagged non-'watching' (idle_report waiting/suppressed) → no enqueue ============
{
  const e = makeEnv();
  seedManager(e, "mgr-5a");
  seedQuestion(e, "mgr-5a", { answeredMinutesAgo: 30 });
  e.db.setIdleNudgePolicy("mgr-5a", "snoozed", minutesAgo(-60)); // snoozed 60m into the future
  e.watcher.tick(NOW);
  check("(5a) a manager snoozed via idle_report('waiting') draws NO answered-stuck nudge either",
    !e.enqueued.some((x) => x.id === "mgr-5a"));

  const e2 = makeEnv();
  seedManager(e2, "mgr-5b");
  seedQuestion(e2, "mgr-5b", { answeredMinutesAgo: 30 });
  e2.db.setIdleNudgePolicy("mgr-5b", "suppressed");
  e2.watcher.tick(NOW);
  check("(5b) a suppressed (escalated/done) manager draws NO answered-stuck nudge",
    !e2.enqueued.some((x) => x.id === "mgr-5b"));
  cleanup(e); cleanup(e2);
}

// ============ (6) a 'pending' question and a 'consumed' question → neither nudges ============
{
  const e = makeEnv();
  seedManager(e, "mgr-6");
  seedQuestion(e, "mgr-6", { state: "pending", answeredMinutesAgo: 30 });
  seedQuestion(e, "mgr-6", { state: "consumed", answeredMinutesAgo: 30 });
  e.watcher.tick(NOW);
  check("(6) neither a pending nor an already-consumed question nudges", !e.enqueued.some((x) => x.id === "mgr-6"));
  cleanup(e);
}

// ============ (7) answered but still under the stuck threshold → not yet ============
{
  const e = makeEnv();
  seedManager(e, "mgr-7");
  seedQuestion(e, "mgr-7", { answeredMinutesAgo: 5 }); // 5m < 15m threshold
  e.watcher.tick(NOW);
  check("(7) an answered question under the stuck threshold is NOT nudged yet", !e.enqueued.some((x) => x.id === "mgr-7"));
  cleanup(e);
}

// ============ (8) storm guard is per-QUESTION, not per-manager: a fresh stuck question still nudges ============
{
  const e = makeEnv();
  seedManager(e, "mgr-8");
  const q1 = seedQuestion(e, "mgr-8", { answeredMinutesAgo: 30, title: "first decision" });
  e.watcher.tick(NOW);
  check("(8) precondition: first question nudged once", e.enqueued.filter((x) => x.id === "mgr-8").length === 1);
  // Pull/consume it (as the manager would via question_pull), then seed a SECOND, independently-stuck question.
  e.db.pullAnsweredQuestions("mgr-8", NOW.toISOString());
  check("(8) precondition: the first question is now consumed", e.db.getQuestion(q1)?.state === "consumed");
  seedQuestion(e, "mgr-8", { answeredMinutesAgo: 30, title: "second decision" });
  e.watcher.tick(NOW);
  const hits = e.enqueued.filter((x) => x.id === "mgr-8");
  check("(8) a second, independently-stuck question for the same manager ALSO nudges (per-question tracking)",
    hits.length === 2 && hits[1].text.includes("second decision"));
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the answered-stuck-question watchdog re-nudges the asking MANAGER (never the human) exactly once per answered→still-answered window for a stuck 'answered' question, staying silent for a rate-limited/parked, human-paused, or self-flagged-non-'watching' manager, for 'pending'/'consumed' questions, and before the stuck threshold elapses; the per-question storm guard doesn't block an unrelated fresh stuck question."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
