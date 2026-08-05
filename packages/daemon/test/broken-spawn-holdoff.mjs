import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 738f2109 DoD: `notifyManagerOfIdleWorker` used to fire [loom:worker-spawn-broken] the INSTANT a
// worker's busy(false) edge landed (index.ts's onBusy hook calls it synchronously right after
// db.setBusy) — zero holdoff, so classifyIdleWorker's broken-spawn kind was eligible on the very FIRST
// give-up cycle, ~5-7s after a fresh kickoff write, well inside the routine engine-confirmation window
// (DoD-1's own measurement: p50=8.5s, p90=45.9s across 177 give-up-driven confirmations). A live
// specimen (worker 67ee24fb, card 03016805) fired at ~22s — under p90 — and the engine confirmed ~1.5s
// after the notice had already drained to the manager.
//
// THE FIX: `pastBrokenSpawnHoldoff` (sessions/service.ts, right after buildBrokenSpawnMsg) gates all
// THREE broken-spawn emission sites — classifyIdleWorker's two branches (engineSessionId null; and
// engineSessionId set but turn never started) plus notifyManagerOfIdleWorker's taskless direct check —
// behind BROKEN_SPAWN_HOLDOFF_MS elapsed since the worker's CURRENT live pty process started
// (pty.liveStartedAt), not `w.lastActivity` (resets on every busy edge — would never elapse) or
// `w.createdAt` (stale across a resume of the same DB row).
//
// This suite drives the REAL SessionService.notifyManagerOfIdleWorker / isWorkerGenuinelyStranded (not a
// re-implemented approximation) against a minimal fake pty that DOES implement `liveStartedAt` (most
// other stubs in this test dir omit it deliberately, to exercise the `typeof`-guard's backward-compatible
// "unmeasurable -> past holdoff" fallback — see worker-idle-spawn-broken-contradiction.mjs and friends,
// unmodified by this card). BROKEN_SPAWN_HOLDOFF_MS has NO env override (a CR follow-up deliberately
// removed one — see that constant's own doc for why an untested `||`-default escape hatch is worse than
// none), so this suite drives real elapsed values either side of its actual 60s value directly via the
// mocked `liveStartedAt` — every "elapsed" value below is computed once via plain arithmetic against
// Date.now(), never a timer, so testing against the real 60s constant costs no real wall-clock time.
//
// (A) NEGATIVE — INSIDE the holdoff: a worker whose pty started well under the real 60s ago, showing the
//     exact "engineSessionId set, turn never started" signature, must draw NO broken-spawn notice yet
//     (both from classifyIdleWorker's tasked path and notifyManagerOfIdleWorker's taskless path).
// (B) POSITIVE — PAST the holdoff: the IDENTICAL signature, but the pty started well past 60s ago, must
//     STILL produce the notice — proving the guard suppresses on TIMING alone, not by silently
//     disarming genuine detection. (A) alone would be indistinguishable from having just broken the
//     nudge outright; (B) is what proves it's a holdoff, not a regression.
// (C) Mirrors (A)/(B) for the OTHER classifyIdleWorker branch (engineSessionId never established at all)
//     and for the taskless direct-check site, so every one of the three gated call sites gets its own
//     positive control, both directions.
// (D) isWorkerGenuinelyStranded (classifyIdleWorker's exposed predicate, used by IdleWatcher's manager-
//     loop message) respects the SAME holdoff — false in-window, true past it.
//
// RUN: pnpm build (from packages/daemon) then `node test/broken-spawn-holdoff.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-broken-spawn-holdoff-${Date.now()}-${process.pid}`);
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

try {
  const now = new Date().toISOString();
  const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  function makeEnv() {
    const dbFile = path.join(tmpHome, `loom-${Math.random().toString(36).slice(2, 8)}.db`);
    const db = new Db(dbFile);
    const projId = `bsh-${sfx}`;
    const agentId = `bsh-ag-${sfx}`;
    db.insertProject({ id: projId, name: "BrokenSpawnHoldoff", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });

    const enqueued = [];
    const firstTurnStarted = new Set();
    const liveStartedAt = new Map(); // sessionId -> epoch ms the fake pty process "started"
    const pty = {
      isAlive: () => true,
      enqueueStdin: (id, text) => { enqueued.push({ id, text }); return { delivered: true }; },
      getPendingEntries: () => [],
      hasFirstTurnStarted: (id) => firstTurnStarted.has(id),
      getComposerDirtyLen: () => undefined,
      liveStartedAt: (id) => liveStartedAt.has(id) ? liveStartedAt.get(id) : null,
    };
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    return { db, projId, agentId, enqueued, firstTurnStarted, liveStartedAt, sessions };
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

  // ============ (A)/(B) tasked, engineSessionId SET but turn never started ============
  {
    const e = makeEnv();
    seedManager(e, "mgr-ab");
    seedTask(e, "tk-a"); seedTask(e, "tk-b");
    seedWorker(e, "wkr-a", "mgr-ab", "tk-a", { engineSessionId: `eng-a-${sfx}` });
    seedWorker(e, "wkr-b", "mgr-ab", "tk-b", { engineSessionId: `eng-b-${sfx}` });
    // hasFirstTurnStarted left false, no transcript on disk for either — the genuine stranded-composer
    // signature. (A) started 1s ago (well inside the real 60s holdoff); (B) started 70s ago (well past it).
    e.liveStartedAt.set("wkr-a", Date.now() - 1_000);
    e.liveStartedAt.set("wkr-b", Date.now() - 70_000);

    e.sessions.notifyManagerOfIdleWorker("wkr-a");
    e.sessions.notifyManagerOfIdleWorker("wkr-b");

    const brokenA = e.enqueued.filter((x) => x.id === "mgr-ab" && x.text.includes("wkr-a") && x.text.includes("[loom:worker-spawn-broken]"));
    const brokenB = e.enqueued.filter((x) => x.id === "mgr-ab" && x.text.includes("wkr-b") && x.text.includes("[loom:worker-spawn-broken]"));
    check("(A) INSIDE holdoff (~1s < 60s): NO broken-spawn notice yet — identical signature to (B)", brokenA.length === 0);
    check("(A) and no OTHER nudge fires either (genuinely silent, not just re-routed)", e.enqueued.filter((x) => x.id === "mgr-ab" && x.text.includes("wkr-a")).length === 0);
    check("(B) PAST holdoff (~70s > 60s): the SAME signature STILL produces the notice", brokenB.length === 1);
    check("(B) the notice reports the observed elapsed time, not just a bare claim", !!brokenB[0] && /~70s since this pty last/.test(brokenB[0].text));
  }

  // ============ (C1) tasked, engineSessionId NEVER established (classifyIdleWorker's other branch) ======
  {
    const e = makeEnv();
    seedManager(e, "mgr-c1");
    seedTask(e, "tk-c1a"); seedTask(e, "tk-c1b");
    seedWorker(e, "wkr-c1a", "mgr-c1", "tk-c1a", {}); // engineSessionId null
    seedWorker(e, "wkr-c1b", "mgr-c1", "tk-c1b", {});
    e.liveStartedAt.set("wkr-c1a", Date.now() - 1_000); // inside holdoff
    e.liveStartedAt.set("wkr-c1b", Date.now() - 70_000); // past holdoff

    e.sessions.notifyManagerOfIdleWorker("wkr-c1a");
    e.sessions.notifyManagerOfIdleWorker("wkr-c1b");

    const brokenIn = e.enqueued.filter((x) => x.id === "mgr-c1" && x.text.includes("wkr-c1a"));
    const brokenPast = e.enqueued.filter((x) => x.id === "mgr-c1" && x.text.includes("wkr-c1b") && x.text.includes("[loom:worker-spawn-broken]"));
    check("(C1) null-engineSessionId branch: INSIDE holdoff draws no notice either", brokenIn.length === 0);
    check("(C1) null-engineSessionId branch: PAST holdoff still fires", brokenPast.length === 1);
  }

  // ============ (C2) TASKLESS direct check (bypasses classifyIdleWorker entirely) ==========================
  {
    const e = makeEnv();
    seedManager(e, "mgr-c2");
    seedWorker(e, "wkr-c2a", "mgr-c2", null, {}); // taskless, engineSessionId null
    seedWorker(e, "wkr-c2b", "mgr-c2", null, {});
    e.liveStartedAt.set("wkr-c2a", Date.now() - 1_000);
    e.liveStartedAt.set("wkr-c2b", Date.now() - 70_000);

    e.sessions.notifyManagerOfIdleWorker("wkr-c2a");
    e.sessions.notifyManagerOfIdleWorker("wkr-c2b");

    const brokenIn = e.enqueued.filter((x) => x.id === "mgr-c2" && x.text.includes("wkr-c2a"));
    const brokenPast = e.enqueued.filter((x) => x.id === "mgr-c2" && x.text.includes("wkr-c2b") && x.text.includes("[loom:worker-spawn-broken]"));
    check("(C2) TASKLESS path: INSIDE holdoff draws no notice (the site classifyIdleWorker doesn't cover)", brokenIn.length === 0);
    check("(C2) TASKLESS path: PAST holdoff still fires (coverage not silently dropped)", brokenPast.length === 1);
  }

  // ============ (D) isWorkerGenuinelyStranded respects the same holdoff ====================================
  {
    const e = makeEnv();
    seedManager(e, "mgr-d");
    seedTask(e, "tk-d1"); seedTask(e, "tk-d2");
    seedWorker(e, "wkr-d1", "mgr-d", "tk-d1", {});
    seedWorker(e, "wkr-d2", "mgr-d", "tk-d2", {});
    e.liveStartedAt.set("wkr-d1", Date.now() - 1_000);
    e.liveStartedAt.set("wkr-d2", Date.now() - 70_000);

    check("(D) INSIDE holdoff: isWorkerGenuinelyStranded is FALSE (not yet confident enough to call it stranded)",
      e.sessions.isWorkerGenuinelyStranded("wkr-d1") === false);
    check("(D) PAST holdoff: isWorkerGenuinelyStranded is TRUE for the identical signature",
      e.sessions.isWorkerGenuinelyStranded("wkr-d2") === true);
  }

} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 738f2109: classifyIdleWorker's broken-spawn kind (both branches) and " +
    "notifyManagerOfIdleWorker's taskless direct check now withhold [loom:worker-spawn-broken] until " +
    "BROKEN_SPAWN_HOLDOFF_MS has elapsed since the worker's CURRENT live pty process started — the exact " +
    "signature that used to fire on the very first busy(false) edge, ~5-7s after a fresh kickoff, now " +
    "waits out the holdoff instead. Positive controls (B/C1/C2/D) prove this is a TIMING gate, not a " +
    "silent regression: the identical broken signature, just older, still fires every one of the three " +
    "gated sites and isWorkerGenuinelyStranded flips true once past it."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
