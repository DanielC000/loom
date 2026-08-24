import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// TASKLESS broken-spawn watchdog coverage (CR follow-up on card 2514e6e1's taskless worker_spawn).
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, mirrors worker-kickoff-guarantee.mjs's (S) block /
// idle-worker-watcher.mjs's harness: a REAL Db + SessionService driven against a lightweight recording
// pty stub (no PtyHost, no real git — this exercises notifyManagerOfIdleWorker's classification logic
// directly, not the worktree/spawn machinery those other files already cover).
//
// THE GAP CLOSED: notifyManagerOfIdleWorker (and classifyIdleWorker underneath it) hard-skipped ANY
// taskless session at their entry guard (`!w.taskId`) — so a taskless worker (an ad-hoc spike, or a
// read-only Code Reviewer with no vehicle card) whose spawn kickoff silently never ran got NO
// [loom:worker-spawn-broken] nudge at all. Before taskless spawns existed, EVERY worker carried a real
// taskId (a vehicle card, if nothing else), so this watchdog covered 100% of workers; taskless spawns
// opened a real coverage hole. FIX: notifyManagerOfIdleWorker now special-cases a taskless worker with
// its OWN narrow (board-state-free) broken-spawn check, mirroring busy-worker-watcher.ts's taskId-
// optional message shape (`w.taskId ? ... : ""`) — while classifyIdleWorker's board-column-dependent
// classification (parked-ack/stranded/etc) stays intentionally out of scope for taskless (no card to
// reconcile against — see that function's own comment).
//
// SILENT-FINISH GAP CLOSED (card df48366b): a taskless worker that DID start a turn (engineSessionId set)
// but then went idle WITHOUT ever calling worker_report used to draw NO signal at all — this branch used
// to `return` unconditionally past the broken-spawn check. It now also checks "has this session EVER
// called worker_report" (no board column to reconcile against, so no parked-ack/re-ack nuance — just
// ever-vs-never) and fires a [loom:worker-idle] nudge on "never".
//
// Proves:
//   (T1) a taskless worker with engineSessionId:null → the SAME [loom:worker-spawn-broken] nudge a tasked
//        worker gets, just with no "(task X)" mention (mirrors worker-kickoff-guarantee.mjs's S1).
//   (T2) a taskless worker with engineSessionId SET (a real turn ran) and NO worker_report ever → a
//        [loom:worker-idle] silent-finish nudge now fires (card df48366b; this used to be silent).
//   (T2b) a taskless worker with engineSessionId SET that HAS called worker_report at least once → NO
//        nudge (the ever-vs-never check is satisfied; no false alarm for the ordinary reported case).
//   (T3) a taskless worker with engineSessionId:null AND pending direction already queued → still SKIPS
//        (the same redirect-race guard classifyIdleWorker applies for tasked workers, applied here too).
//   (T4) a TASKED worker's broken-spawn nudge is completely unaffected (still fires, still names the task)
//        — the taskless branch is additive, not a regression on the existing path.
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-spawn-broken-taskless.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const NOW = new Date();

function makeEnv() {
  const dbFile = path.join(os.tmpdir(), `loom-wsbt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `wsbt-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `wsbta-${Math.random().toString(36).slice(2, 8)}`;
  const now = NOW.toISOString();
  db.insertProject({ id: projId, name: "Taskless", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
  const enqueued = [];
  const pendingBySession = new Map();
  // Card 6651bf24: `notifyManagerOfIdleWorker`'s taskless branch now consults `hasFirstTurnStarted`
  // (mirrors classifyIdleWorker's own stub contract — see kickoff-giveup-exhausted.mjs /
  // worker-idle-spawn-broken-contradiction.mjs for the same per-session-settable-Set pattern). Default
  // false (unstarted) unless a test explicitly marks a session id into the Set.
  const firstTurnStarted = new Set();
  const pty = {
    enqueueStdin: (id, text) => {
      enqueued.push({ id, text });
      const s = db.getSession(id);
      return s?.processState === "live" ? { delivered: true } : { delivered: false, position: 1 };
    },
    getPendingEntries: (id) => pendingBySession.get(id) ?? [],
    hasFirstTurnStarted: (id) => firstTurnStarted.has(id),
  };
  const sessions = new SessionService(db, pty, new OrchestrationControl());
  return { dbFile, db, projId, agentId, enqueued, sessions, pendingBySession, firstTurnStarted };
}
function seedSession(e, id, { role = "worker", processState = "live", parentSessionId = null, taskId = null, branch = null, engineSessionId = "eng-" + id, turnSeq = 0 } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId, title: null, cwd: e.projId,
    processState, resumability: "resumable", busy: false,
    createdAt: NOW.toISOString(), lastActivity: NOW.toISOString(), lastError: null, role,
    parentSessionId, taskId, ctxInputTokens: null, ctxTurns: null, model: null, worktreePath: null, branch,
  });
  // LOAD-BEARING (card 6651bf24): `insertSession`'s own INSERT statement does NOT list `turn_seq` at all
  // (db.ts ~4587-4596) — passing `turnSeq` straight into the inserted object is a silent no-op, caught
  // while writing this fix. `turn_seq` only ever moves via `incrementTurnSeq` (the same method the real
  // Stop-hook chokepoint calls), so that's what actually seeds a non-zero value here. Do NOT "simplify"
  // this back to an inline `turnSeq` field on the insert object — it would silently stop doing anything.
  for (let i = 0; i < turnSeq; i++) e.db.incrementTurnSeq(id);
}
function seedTask(e, id, columnKey = "in_progress") {
  e.db.insertTask({ id, projectId: e.projId, title: "T-" + id, body: "", columnKey, position: 0, priority: "p2", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
}
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ============ (T1) taskless + engineSessionId:null → broken-spawn nudge, no task mention ============
{
  const e = makeEnv();
  seedSession(e, "mgr-t1", { role: "manager" });
  // TASKLESS: no taskId, no branch pinned via a task — mirrors a real taskless worker_spawn row.
  seedSession(e, "wkr-t1", { taskId: null, parentSessionId: "mgr-t1", branch: "loom/spike-t1", engineSessionId: null });

  e.sessions.notifyManagerOfIdleWorker("wkr-t1");
  const broken = e.enqueued.find((x) => x.id === "mgr-t1" && /worker-spawn-broken/.test(x.text));
  check("(T1) taskless + engineSessionId:null → a [loom:worker-spawn-broken] nudge IS pushed (the gap this closes)", !!broken);
  check("(T1) the nudge names the worker", !!broken && broken.text.includes("wkr-t1"));
  check("(T1) the nudge has NO '(task ...)' mention (there is no task)", !!broken && !/\(task /.test(broken.text));
  check("(T1) the nudge is explicit this is NOT benign", !!broken && /NOT a benign/i.test(broken.text));
  // Card 92902cc2: genuinely no engine session here → the "no engine session" cause IS true for this
  // specimen — the fix conditions the clause, it doesn't delete it outright.
  check("(T1) the cause correctly states no engine session was ever established (true for this specimen)",
    !!broken && /no engine session was ever established/.test(broken.text));
  check("(T1) does NOT claim it will not resolve on its own (card 6229dcc0's false clause, measured FALSE 2/2 — dropped)",
    !!broken && !/will not resolve on its own/.test(broken.text));
  // Card 92902cc2 DoD: report observed fields, not just a prose cause — a recipient can diagnose from them.
  check("(T1) reports engineSessionId=none", !!broken && /engineSessionId=none/.test(broken.text));
  // Card 92902cc2's remedy order (site A's shape, reused): don't recommend worker_message until verified.
  check("(T1) does NOT recommend worker_message before verification (mirrors site A's remedy order)",
    !!broken && /do NOT worker_message it/.test(broken.text));
  // Card 738f2109 DoD-2: worker_status now LEADS as the cheap non-destructive check, but worker_transcript
  // is still named the decisive one — wording changed, the verify-before-destructive-remedy order didn't.
  check("(T1) leads with worker_status as the cheap non-destructive check", !!broken && /worker_status\(\{workerSessionId/.test(broken.text));
  check("(T1) points at worker_transcript as the decisive verify-first check", !!broken && /worker_transcript wkr-t1 — the DECISIVE check/.test(broken.text));
  check("(T1) exactly ONE nudge fires (no double-signal)", e.enqueued.filter((x) => x.id === "mgr-t1").length === 1);
  cleanup(e);
}

// ============ (T2) taskless + a GENUINELY COMPLETED turn (turnSeq>=1) + NEVER reported → silent-finish
// nudge, UNCHANGED (card df48366b's original behavior; card 6651bf24 DoD-6 test 3 — the regression pin
// for the case that must NOT move when discriminators A/B are added). LOAD-BEARING SEED: both
// `firstTurnStarted.add(...)` AND `turnSeq: 1` are required here — without EITHER, this specimen falls
// into the NEW discriminator-A or discriminator-B branch post-fix instead of this one, and this test would
// silently start measuring a different code path than the one it names. (`turnSeq` defaults to 0 —
// db.ts:7132 — so leaving it unset here is exactly the trap that made the pre-fix version of this test
// pass for the wrong reason: it never actually distinguished "genuinely completed" from "never completed".)
{
  const e = makeEnv();
  seedSession(e, "mgr-t2", { role: "manager" });
  seedSession(e, "wkr-t2", { taskId: null, parentSessionId: "mgr-t2", branch: "loom/spike-t2", engineSessionId: "eng-wkr-t2", turnSeq: 1 });
  e.firstTurnStarted.add("wkr-t2");

  e.sessions.notifyManagerOfIdleWorker("wkr-t2");
  const idle = e.enqueued.find((x) => x.id === "mgr-t2" && /worker-idle/.test(x.text));
  check("(T2) taskless + turnSeq>=1 + never reported → a [loom:worker-idle] silent-finish nudge fires",
    !!idle);
  // BYTE-IDENTICAL regression pin (not a partial regex) — proves discriminators A/B didn't alter this
  // branch's wording at all for the case that's supposed to be untouched.
  const expected = `[loom:worker-idle] worker wkr-t2 finished a turn and is idle but has never called worker_report (taskless — no board card to check). It may be done-but-unreported or stalled — pull it: worker_transcript wkr-t2 to see what it did, then worker_message it or worker_stop it once reviewed.`;
  check("(T2) the nudge wording is BYTE-IDENTICAL to the pre-fix text (DoD-6 test 3)", !!idle && idle.text === expected);
  cleanup(e);
}

// ============ (T5) DoD-6 test 1 (card 6651bf24, SPECIMEN 1 shape): engineSessionId SET but a turn never
// genuinely started (hasFirstTurnStarted:false, empty transcript, never reported) → DISCRIMINATOR A fires
// → broken-spawn wording, NEVER "finished a turn". RED-PROOF: pre-fix code had no discriminator-A check at
// all once engineSessionId was set — it went straight to the plain silentFinishMsg (`finished a turn and
// is idle`) for this exact state; this is the case that was silently wrong before this card. ============
{
  const e = makeEnv();
  seedSession(e, "mgr-t5", { role: "manager" });
  seedSession(e, "wkr-t5", { taskId: null, parentSessionId: "mgr-t5", branch: "loom/spike-t5", engineSessionId: "eng-wkr-t5" });
  // firstTurnStarted left false (default); no worker_report; transcript stays empty (fake cwd, no file).

  e.sessions.notifyManagerOfIdleWorker("wkr-t5");
  const msgs = e.enqueued.filter((x) => x.id === "mgr-t5");
  check("(T5) exactly one nudge fires", msgs.length === 1);
  check("(T5) it is the broken-spawn nudge (discriminator A), not silent-finish", !!msgs[0] && /worker-spawn-broken/.test(msgs[0].text));
  check("(T5) it never asserts 'finished a turn' (the false claim this card fixes)", !!msgs[0] && !/finished a turn/.test(msgs[0].text));
  cleanup(e);
}

// ============ (T6) DoD-6 test 2 (card 6651bf24, SPECIMEN 2's actual production shape — amended by the
// manager onto the card: reworded, not suppressed, per DoD-4 "fix the claim, don't silence the nudge"):
// engineSessionId SET, hasFirstTurnStarted:TRUE (a turn genuinely started — proven this can coexist with
// turnSeq:0 by host.ts:4740/4753/5381/8790-8801, all in the SAME UserPromptSubmit hook case), turnSeq:0
// (never completed), never reported → DISCRIMINATOR B fires → a nudge FIRES but does NOT claim completion.
// RED-PROOF: pre-fix code (and my FIRST, rejected plan — discriminator A alone) both emit the plain
// "finished a turn and is idle" wording for this exact state; this is the test that would have caught
// that gap. ============
{
  const e = makeEnv();
  seedSession(e, "mgr-t6", { role: "manager" });
  seedSession(e, "wkr-t6", { taskId: null, parentSessionId: "mgr-t6", branch: "loom/spike-t6", engineSessionId: "eng-wkr-t6" });
  e.firstTurnStarted.add("wkr-t6"); // turn started ... turnSeq stays 0 (default) — never completed

  e.sessions.notifyManagerOfIdleWorker("wkr-t6");
  const msgs = e.enqueued.filter((x) => x.id === "mgr-t6");
  check("(T6) a nudge FIRES (reworded, not suppressed — DoD-4)", msgs.length === 1);
  check("(T6) it does NOT claim 'finished a turn'", !!msgs[0] && !/finished a turn/.test(msgs[0].text));
  check("(T6) it explicitly states the turn has NOT completed", !!msgs[0] && /has NOT completed one/.test(msgs[0].text));
  check("(T6) it names turnSeq=0", !!msgs[0] && /turnSeq=0/.test(msgs[0].text));
  check("(T6) it points at a LIVE re-check (worker_status) before any escalation", !!msgs[0] && /Re-check LIVE first: worker_status/.test(msgs[0].text));
  check("(T6) worker_stop is demoted behind that re-check confirming it's stuck (mirrors 17732398)", !!msgs[0] && /once that confirms it's genuinely stuck/.test(msgs[0].text));
  cleanup(e);
}

// ============ (T7) DoD-6 test 4: a STOPPED (exited) 0-turn taskless session never synthesizes a
// completion either — same discriminator-A state as T5, with processState varied to rule out a hidden
// dependency on process state (the function never reads processState at all). ============
{
  const e = makeEnv();
  seedSession(e, "mgr-t7", { role: "manager" });
  seedSession(e, "wkr-t7", { taskId: null, parentSessionId: "mgr-t7", branch: "loom/spike-t7", engineSessionId: "eng-wkr-t7", processState: "exited" });

  e.sessions.notifyManagerOfIdleWorker("wkr-t7");
  const msgs = e.enqueued.filter((x) => x.id === "mgr-t7");
  check("(T7) a stopped 0-turn session still does not synthesize 'finished a turn'", msgs.every((m) => !/finished a turn/.test(m.text)));
  cleanup(e);
}

// ============ (T2b) taskless + engineSessionId SET + ALREADY reported → NO false alarm ============
{
  const e = makeEnv();
  seedSession(e, "mgr-t2b", { role: "manager" });
  seedSession(e, "wkr-t2b", { taskId: null, parentSessionId: "mgr-t2b", branch: "loom/spike-t2b", engineSessionId: "eng-wkr-t2b" });
  await e.sessions.workerReport("wkr-t2b", { status: "done", summary: "spike done", noChanges: true });
  e.enqueued.length = 0; // isolate to the notify call below

  e.sessions.notifyManagerOfIdleWorker("wkr-t2b");
  check("(T2b) a taskless worker that HAS called worker_report at least once draws NO false silent-finish nudge",
    e.enqueued.filter((x) => x.id === "mgr-t2b").length === 0);
  cleanup(e);
}

// ============ (T3) taskless + engineSessionId:null + pending direction queued → still SKIPS ============
{
  const e = makeEnv();
  seedSession(e, "mgr-t3", { role: "manager" });
  seedSession(e, "wkr-t3", { taskId: null, parentSessionId: "mgr-t3", branch: "loom/spike-t3", engineSessionId: null });
  e.pendingBySession.set("wkr-t3", [{ id: "m1", text: "[loom:from-manager:redirect]\ndo X instead", source: "system" }]);

  e.sessions.notifyManagerOfIdleWorker("wkr-t3");
  check("(T3) pending direction still suppresses the taskless broken-spawn nudge (same redirect-race guard as tasked)",
    e.enqueued.length === 0);
  cleanup(e);
}

// ============ (T4) a TASKED worker's broken-spawn nudge is unaffected by the taskless branch ============
{
  const e = makeEnv();
  seedSession(e, "mgr-t4", { role: "manager" });
  seedTask(e, "tk-t4");
  seedSession(e, "wkr-t4", { taskId: "tk-t4", parentSessionId: "mgr-t4", branch: "loom/tk-t4", engineSessionId: null });

  e.sessions.notifyManagerOfIdleWorker("wkr-t4");
  const broken = e.enqueued.find((x) => x.id === "mgr-t4" && /worker-spawn-broken/.test(x.text));
  check("(T4) a TASKED worker's broken-spawn nudge still fires", !!broken);
  check("(T4) it still names the task (unlike the taskless case in T1)", !!broken && broken.text.includes("tk-t4") && /\(task /.test(broken.text));
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — notifyManagerOfIdleWorker now covers a TASKLESS worker's broken spawn (engineSessionId never established → [loom:worker-spawn-broken], no task mention, same redirect-race guard as tasked) AND its silent finish (engineSessionId set, never reported → [loom:worker-idle], card df48366b) — a taskless worker that has reported at least once draws no false alarm; a TASKED worker's existing broken-spawn coverage still fires (card 92902cc2 changed the notice's WORDING — cause now computed per-specimen instead of hardcoded — not whether it fires)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
