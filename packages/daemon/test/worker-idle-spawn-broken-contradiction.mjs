import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 2281009d — split from f91c8634 (p1) DoD-3: the CHEAP half of "two Loom nudges fired for ONE
// session, back to back, giving OPPOSITE advice":
//   [loom:worker-idle]         — "finished a turn and is idle… worker_merge to review, or worker_message it."
//   [loom:worker-spawn-broken] — "…do NOT worker_message it… do NOT worker_merge it."
//
// ROOT CAUSE: two INDEPENDENT emitters both watch for "this worker never really started":
//   (1) handleKickoffGiveUpExhausted (fires on give-up-budget exhaustion) already discriminates correctly —
//       it checks `hasFirstTurnStarted(id) || readTranscript(...).length > 0` before deciding the kickoff
//       was genuinely dropped.
//   (2) classifyIdleWorker (fires on every busy->false edge / periodic idle tick, feeding
//       notifyManagerOfIdleWorker) used a NARROWER, wrong proxy: `!w.engineSessionId` alone. But
//       engineSessionId is captured on the engine's SessionStart hook — which can fire while the kickoff
//       sits unsent in the composer forever (card f91c8634's parked-Enter signature) — so a session with
//       engineSessionId SET but turnSeq still 0 fell straight through classifyIdleWorker's broken-spawn
//       check into the generic "did NOT call worker_report" branch, emitting [loom:worker-idle] alongside
//       (1)'s correct [loom:worker-spawn-broken] for the SAME session.
//
// THE FIX: classifyIdleWorker's broken-spawn branch now ALSO checks the SAME discriminator (1) already
// uses (hasFirstTurnStarted OR non-empty transcript) before falling through — so both emitters agree on
// ONE fact instead of two disagreeing ones. Per card DIRECTION #3, worker-idle's CONTENT is untouched;
// this is a narrow carve-out, not a de-tuning — proven below by (B), the discriminator case.
//
// This suite drives the REAL SessionService.notifyManagerOfIdleWorker (not a stub) against a minimal
// fake pty (mirrors idle-worker-watcher.mjs's own contract) plus a real on-disk transcript fixture
// (mirrors kickoff-giveup-exhausted.mjs's writeLiveTranscript) so classifyIdleWorker's actual production
// code path — including the real readTranscript() filesystem read — is exercised end to end, not a
// re-implemented approximation of it.
//
// Every assertion here is a direct, SYNCHRONOUS check on notifyManagerOfIdleWorker's return-path side
// effect (what got enqueued) immediately after calling it — no fixed sleep, no "wait and see if nothing
// happened" window anywhere in this file, so the assertNeverWithControl requirement (card DoD-4, for a
// negative assertion gated only by a fixed wait) does not apply: there is nothing here for that pattern
// to apply TO.
//
// (A) POSITIVE — THE CONTRADICTION CASE: engineSessionId captured (SessionStart fired), but no turn ever
//     started (hasFirstTurnStarted:false, empty on-disk transcript, never worker_report'd). Pre-fix this
//     produced BOTH nudges for one session; this test proves it now produces ONLY worker-spawn-broken.
// (B) THE DISCRIMINATOR (the load-bearing half, per the card): an ORDINARY idle worker — turn genuinely
//     started (hasFirstTurnStarted:true) but never called worker_report — must STILL get the plain
//     [loom:worker-idle] "did NOT call worker_report" nudge, completely unaffected by the fix. A
//     suppression tested only against (A) would be indistinguishable from having simply broken the
//     nudge outright; (B) is what proves it discriminates rather than just silences.
//
// RUN: pnpm build (from packages/daemon) then `node test/worker-idle-spawn-broken-contradiction.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic HOME/USERPROFILE BEFORE importing anything that reads it (readTranscript resolves off
// os.homedir() — see sessions/transcript.ts) — mirrors kickoff-giveup-exhausted.mjs's own convention, so
// this suite never touches the real ~/.claude/projects.
const tmpHome = path.join(os.tmpdir(), `loom-idle-spawn-broken-${Date.now()}-${process.pid}`);
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");

/** Writes a real transcript JSONL to the (sandboxed) ~/.claude/projects/... path readTranscript resolves
 *  — mirrors kickoff-giveup-exhausted.mjs's own writeLiveTranscript fixture helper. */
function writeLiveTranscript(cwd, engineSessionId, turnTexts) {
  const file = engineTranscriptPath(cwd, engineSessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, turnTexts.map((t, i) =>
    JSON.stringify({ type: i % 2 === 0 ? "user" : "assistant", message: { content: [{ type: "text", text: t }] } })
  ).join("\n") + "\n");
}

try {
  const NOW = new Date();
  const now = NOW.toISOString();
  const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  function makeEnv() {
    const dbFile = path.join(tmpHome, `loom-${Math.random().toString(36).slice(2, 8)}.db`);
    const db = new Db(dbFile);
    const projId = `isb-${sfx}`;
    const agentId = `isb-ag-${sfx}`;
    db.insertProject({ id: projId, name: "IdleSpawnBroken", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });

    const enqueued = [];
    const firstTurnStarted = new Set();
    // Minimal contract-faithful pty stub: getPendingEntries empty (nothing queued), enqueueStdin records,
    // hasFirstTurnStarted is per-session settable — mirrors idle-worker-watcher.mjs's fake pty plus
    // kickoff-giveup-exhausted.mjs's PtyStub.setFirstTurnStarted, combined (the real classifyIdleWorker
    // now consults BOTH `this.pty.hasFirstTurnStarted` and the real on-disk transcript).
    const pty = {
      isAlive: () => true,
      enqueueStdin: (id, text) => { enqueued.push({ id, text }); return { delivered: true }; },
      getPendingEntries: () => [],
      hasFirstTurnStarted: (id) => firstTurnStarted.has(id),
    };
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    return { db, projId, agentId, enqueued, firstTurnStarted, sessions };
  }
  function seedManager(e, id) {
    e.db.insertSession({
      id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
      processState: "live", resumability: "resumable", busy: false,
      createdAt: now, lastActivity: now, lastError: null, role: "manager",
      ctxInputTokens: null, ctxTurns: null, model: null,
    });
  }
  function seedWorker(e, id, parentId, taskId, { engineSessionId } = {}) {
    e.db.insertSession({
      id, projectId: e.projId, agentId: e.agentId, engineSessionId: engineSessionId ?? null, title: null, cwd: e.projId,
      processState: "live", resumability: "resumable", busy: false,
      createdAt: now, lastActivity: now, lastError: null, role: "worker",
      parentSessionId: parentId, taskId, ctxInputTokens: null, ctxTurns: null, model: null,
    });
  }
  function seedTask(e, id) {
    e.db.insertTask({ id, projectId: e.projId, title: "T-" + id, body: "", columnKey: "in_progress", position: 0, createdAt: now, updatedAt: now });
  }

  // ============ (A) POSITIVE — the exact contradiction: engineSessionId captured, turn NEVER started =====
  {
    const e = makeEnv();
    seedManager(e, "mgr-a");
    seedTask(e, "tk-a");
    const engId = `eng-wkr-a-${sfx}`;
    seedWorker(e, "wkr-a", "mgr-a", "tk-a", { engineSessionId: engId }); // engineSessionId SET
    // hasFirstTurnStarted left false (default), and no transcript file written for engId — the exact
    // "SessionStart fired, turn 1 never ran" signature from card f91c8634's live specimens.

    e.sessions.notifyManagerOfIdleWorker("wkr-a");

    const spawnBroken = e.enqueued.filter((x) => x.id === "mgr-a" && x.text.includes("[loom:worker-spawn-broken]"));
    const workerIdle = e.enqueued.filter((x) => x.id === "mgr-a" && x.text.includes("[loom:worker-idle]"));
    check("(A) spawn-broken condition: gets [loom:worker-spawn-broken]", spawnBroken.length === 1);
    check("(A) spawn-broken condition: does NOT ALSO get the contradictory [loom:worker-idle]", workerIdle.length === 0);
    check("(A) exactly ONE nudge total for this session (no double-fire)", e.enqueued.filter((x) => x.id === "mgr-a").length === 1);
  }

  // ============ (B) THE DISCRIMINATOR — an ORDINARY idle worker still gets [loom:worker-idle] exactly ====
  // ============     as before (turn genuinely started, just never called worker_report) ===================
  {
    const e = makeEnv();
    seedManager(e, "mgr-b");
    seedTask(e, "tk-b");
    const engId = `eng-wkr-b-${sfx}`;
    seedWorker(e, "wkr-b", "mgr-b", "tk-b", { engineSessionId: engId });
    e.firstTurnStarted.add("wkr-b"); // the discriminator: this session genuinely ran a turn
    // Also back it with a real non-empty transcript — belt-and-suspenders proof this is the healthy case,
    // not merely a bare pty-level flag (mirrors kickoff-giveup-exhausted.mjs's own (S9) discriminator).
    writeLiveTranscript(e.projId, engId, ["orchestrate task tk-b", "on it — reading the card now"]);

    e.sessions.notifyManagerOfIdleWorker("wkr-b");

    const workerIdle = e.enqueued.filter((x) => x.id === "mgr-b" && x.text.includes("[loom:worker-idle]"));
    const spawnBroken = e.enqueued.filter((x) => x.id === "mgr-b" && x.text.includes("[loom:worker-spawn-broken]"));
    check("(B) DISCRIMINATOR: an ordinary idle (turn-started, unreported) worker STILL gets [loom:worker-idle]", workerIdle.length === 1);
    check("(B) DISCRIMINATOR: it does NOT get [loom:worker-spawn-broken] (it genuinely isn't broken)", spawnBroken.length === 0);
    check("(B) the worker-idle wording is the pre-existing 'did NOT call worker_report' shape (content untouched)",
      workerIdle[0]?.text.includes("did NOT call worker_report") ?? false);
  }

  // ============ (C) NEGATIVE CONTROL for (A)'s discriminator: !engineSessionId at all is STILL ============
  // ============     broken-spawn (the pre-existing, unchanged branch) — proves (A)'s new check is ADDITIVE
  {
    const e = makeEnv();
    seedManager(e, "mgr-c");
    seedTask(e, "tk-c");
    seedWorker(e, "wkr-c", "mgr-c", "tk-c", {}); // engineSessionId null — the ORIGINAL broken-spawn signature

    e.sessions.notifyManagerOfIdleWorker("wkr-c");

    const spawnBroken = e.enqueued.filter((x) => x.id === "mgr-c" && x.text.includes("[loom:worker-spawn-broken]"));
    check("(C) the pre-existing null-engineSessionId broken-spawn path is unregressed", spawnBroken.length === 1);
  }

} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 2281009d: classifyIdleWorker's broken-spawn detection now also catches 'engineSessionId captured but turn 1 never started' (not just null engineSessionId), so notifyManagerOfIdleWorker no longer fires the contradictory [loom:worker-idle] alongside handleKickoffGiveUpExhausted's [loom:worker-spawn-broken] for the same never-started session (A). An ORDINARY idle worker that genuinely ran a turn but never reported STILL gets the plain [loom:worker-idle] nudge, completely unaffected (B) — the discriminator that proves this is a narrow carve-out, not a de-tuning. The original null-engineSessionId broken-spawn path is unregressed (C)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
