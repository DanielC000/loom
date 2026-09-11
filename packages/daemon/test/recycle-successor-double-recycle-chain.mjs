import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card f349f5cb, Code Review finding 1 — the DOUBLE-RECYCLE race: a session mid-recycling ITSELF
// must never be reconciled by `SessionService.reconcileNeverStartedRecycleSuccessor`.
//
// The bug (verified against source, not just reasoned about): `recycleWorker` hard-kills its OWN
// predecessor SYNCHRONOUSLY and WAITS (up to ~5s) for the real exit BEFORE inserting the fresh successor
// row. If that predecessor (B) is ITSELF a never-started recycle successor of an EARLIER recycle (A→B,
// B never reached SessionStart), then recycling B into C (worker_recycle on B) hard-kills B — and B's
// real `onExit` is GUARANTEED to fire (reaching `reconcileNeverStartedRecycleSuccessor`) BEFORE C is ever
// inserted, so `hasSuccessor(B)` reads FALSE at that exact moment even though B is legitimately continued
// into C moments later. Without a fix, that reconciliation would sever B's own link to A
// (`recycled_from = null`) while C is the real live continuation on the same worktree — leaving `A | B→C`,
// with A wrongly read as un-superseded (`hasSuccessor(A) === false`) even though the chain is intact.
//
// Fix under test: `recycleTeardownInFlight`, a `Set<string>` marked on `workerSessionId` from just before
// `recycleWorker`'s own hard-kill until the call settles — `reconcileNeverStartedRecycleSuccessor` skips
// entirely while a session's id is in that set. `recycleManager` needs NO such marker: it inserts its
// fresh row BEFORE ever touching the old session's pty (a DEFERRED stop, seconds later), so
// `hasSuccessor(sessionId)` — checked unconditionally by this method regardless of role — is already true
// by the time the old manager session actually exits.
//
// Proves:
//   (1) WORKER CHAIN (recycleTeardownInFlight): A→B (B never starts) → recycle B into C. B's own onExit
//       (fired synchronously during recycleWorker(B)'s internal hard-kill, BEFORE C is inserted) must NOT
//       unlink B→A. After the chain settles: hasSuccessor(A) is TRUE (via B, unchanged), B.recycledFrom is
//       STILL A, hasSuccessor(B) is TRUE (via C), C.recycledFrom is B.
//   (2) CASCADE — C also dies before SessionStart (a THIRD-generation never-started successor): killing
//       C's own pty correctly unlinks C→B (hasSuccessor(B) flips to false, C's own recycle_failed is
//       recorded) WITHOUT disturbing the earlier, legitimate A→B link (hasSuccessor(A) stays TRUE
//       throughout) — proving the fix only ever touches the ONE link it's actually reconciling.
//   (3) MANAGER CHAIN (hasSuccessor alone, no marker needed): M1→M2 (M2 never starts) → recycle M2 into
//       M3. M3 is inserted BEFORE M2's pty is ever touched (mirrors recycleManager's real deferred-stop
//       shape) — by the time M2's pty is killed (simulating the deferred stop having fired),
//       hasSuccessor(M2) is already TRUE, so `reconcileNeverStartedRecycleSuccessor` no-ops on M2 without
//       needing recycleTeardownInFlight at all. hasSuccessor(M1) stays TRUE (via M2) throughout.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE: a REAL Db + SessionService + PtyHost driven against a FAKE
// low-level pty (the shared createPty() seam — see _seam-host-fixture.mjs) with captured handles per
// session, exercising the REAL host.ts spawn/onExit wiring end to end for every generation in the chain.
//
// Run: 1) build (turbo builds shared first), 2) node test/recycle-successor-double-recycle-chain.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-rsddrc-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, removeWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=rsddrc@loom -c user.name=rsddrc";
function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-rsddrc-repo-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# recycle-successor-double-recycle-chain ${tag}\n`);
  execSync(`git init -q`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

class SeamHost extends createSeamHost(PtyHost) {
  handles = new Map(); // sessionId -> the fake low-level pty object
  createPty(opts) { const pty = super.createPty(opts); this.handles.set(opts.sessionId, pty); return pty; }
}
const db = new Db();
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id, code, info) {
    db.setProcessState(id, "exited");
    db.setBusy(id, false);
    // Mirrors index.ts's real onExit hook exactly (order + args), including the fix under test.
    const exited = db.getSession(id);
    if (exited) sessions.archiveOnExit(exited);
    if (exited) sessions.reconcileNeverStartedRecycleSuccessor(id, info.intended);
  },
};
const host = new SeamHost(events);
const sessions = new SessionService(db, host, new OrchestrationControl());

const worktreesToClean = [];
try {
  // ==================== (1)/(2) WORKER CHAIN — recycleTeardownInFlight ====================
  {
    const P = "rsddrc-worker", repo = makeRepo("worker");
    const { worktreePath, branch } = await createWorktree(repo, P, "wa");
    worktreesToClean.push([repo, worktreePath]);
    const now = new Date().toISOString();
    db.insertProject({ id: P, name: "RSDDRC-Worker", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-mgr`, projectId: P, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
    db.insertAgent({ id: `${P}-dev`, projectId: P, name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
    db.insertTask({ id: "wa", projectId: P, title: "wa", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const mgrId = `${P}-mgr1`, workerAId = `${P}-wkrA`;
    db.insertSession({ id: mgrId, projectId: P, agentId: `${P}-mgr`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: workerAId, projectId: P, agentId: `${P}-dev`, engineSessionId: "eng-old-a", title: null, cwd: worktreePath, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: "wa", worktreePath, branch });

    // --- gen 1: recycle A into B ---
    const workerB = await sessions.recycleWorker(mgrId, workerAId, "handoff #1 — A into B");
    db.setProcessState(workerAId, "exited"); // A was DB-seeded, never host.spawn()'d — stamp it dead as it genuinely would be (mirrors the main test's own setup)
    check("(1 pre) recycleWorker(A) succeeded, minting B", !!workerB && workerB.recycledFrom === workerAId);
    check("(1 pre) B never captured an engineSessionId (never reached SessionStart)", !db.getSession(workerB.id)?.engineSessionId);
    check("(1 pre) hasSuccessor(A) is TRUE via B", db.hasSuccessor(workerAId) === true);

    // --- gen 2: recycle B into C. THIS is where the race lives: recycleWorker(B)'s own internal
    // hard-kill fires B's REAL onExit — reaching reconcileNeverStartedRecycleSuccessor(B) — BEFORE C is
    // ever inserted. Without the fix, this would wrongly unlink B -> A right here. ---
    const workerC = await sessions.recycleWorker(mgrId, workerB.id, "handoff #2 — B into C (the race)");
    check("(1) recycleWorker(B) succeeded, minting C (the race did not throw/corrupt the call)",
      !!workerC && workerC.recycledFrom === workerB.id);

    check("(1) FIX: B's own recycledFrom is STILL A — NOT wrongly unlinked by its own teardown-into-C",
      db.getSession(workerB.id)?.recycledFrom === workerAId);
    check("(1) FIX: hasSuccessor(A) is STILL TRUE via B — A is correctly superseded, never falsely freed",
      db.hasSuccessor(workerAId) === true);
    check("(1) FIX: hasSuccessor(B) is TRUE via C — the chain continues correctly",
      db.hasSuccessor(workerB.id) === true);
    check("(1) FIX: NO recycle_failed event was fabricated for B's own teardown-into-C",
      db.listEventsForWorker(workerB.id).filter((e) => e.kind === "recycle_failed").length === 0);

    // --- (2) CASCADE: C is ALSO a never-started successor (never reaches SessionStart) — kill it for
    // real and confirm ONLY the C -> B link is touched, never the earlier, legitimate A -> B link. ---
    check("(2 pre) C never captured an engineSessionId either", !db.getSession(workerC.id)?.engineSessionId);
    const cPty = host.handles.get(workerC.id);
    check("(setup precondition) C's own fake pty handle was captured", !!cPty);
    cPty.kill();

    check("(2) FIX: C's own recycledFrom is unlinked (C genuinely never started)",
      db.getSession(workerC.id)?.recycledFrom === null);
    check("(2) FIX: hasSuccessor(B) flips to FALSE now that its only successor (C) is unlinked",
      db.hasSuccessor(workerB.id) === false);
    check("(2) FIX: a recycle_failed event IS recorded for C's own teardown",
      db.listEventsForWorker(workerC.id).filter((e) => e.kind === "recycle_failed").length === 1);
    check("(2) FIX: the EARLIER A -> B link is COMPLETELY UNDISTURBED by C's own reconciliation",
      db.getSession(workerB.id)?.recycledFrom === workerAId && db.hasSuccessor(workerAId) === true);
  }

  // ==================== (3) MANAGER CHAIN — hasSuccessor(sessionId) alone, no marker needed ====================
  {
    const P = "rsddrc-manager", repo = makeRepo("manager");
    worktreesToClean.push([repo, null]);
    const now = new Date().toISOString();
    db.insertProject({ id: P, name: "RSDDRC-Manager", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-mgr`, projectId: P, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
    const mgr1Id = `${P}-mgr1`;
    db.insertSession({ id: mgr1Id, projectId: P, agentId: `${P}-mgr`, engineSessionId: "eng-old-mgr1", title: null, cwd: repo, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    // --- gen 1: recycle M1 into M2 ---
    const mgr2 = await sessions.recycleManager(mgr1Id, "continuation #1 — M1 into M2");
    db.setProcessState(mgr1Id, "exited"); // M1 was DB-seeded, never host.spawn()'d — stamp it dead as it genuinely would be
    check("(3 pre) recycleManager(M1) succeeded, minting M2", !!mgr2 && mgr2.recycledFrom === mgr1Id);
    check("(3 pre) hasSuccessor(M1) is TRUE via M2", db.hasSuccessor(mgr1Id) === true);

    // --- gen 2: recycle M2 into M3. recycleManager inserts M3 BEFORE ever touching M2's pty (a deferred
    // stop, seconds later in production) — so by construction hasSuccessor(M2) is already TRUE by the
    // time M2's pty is eventually killed below, protecting it WITHOUT needing recycleTeardownInFlight. ---
    const mgr3 = await sessions.recycleManager(mgr2.id, "continuation #2 — M2 into M3 (no marker needed)");
    check("(3) recycleManager(M2) succeeded, minting M3", !!mgr3 && mgr3.recycledFrom === mgr2.id);
    check("(3 pre) hasSuccessor(M2) is ALREADY TRUE via M3 the instant M3 is inserted — before M2's own pty is ever touched",
      db.hasSuccessor(mgr2.id) === true);

    // Simulate the deferred stop having fired for M2 (recycleManager's own setTimeout — not awaited here,
    // so kill it directly to exercise the SAME onExit path deterministically instead of a real 3s wait).
    const m2Pty = host.handles.get(mgr2.id);
    check("(setup precondition) M2's own fake pty handle was captured", !!m2Pty);
    m2Pty.kill();

    check("(3) FIX: M2's own recycledFrom is STILL M1 — the hasSuccessor(M2) guard alone protected it, no marker needed",
      db.getSession(mgr2.id)?.recycledFrom === mgr1Id);
    check("(3) FIX: hasSuccessor(M1) is STILL TRUE via M2", db.hasSuccessor(mgr1Id) === true);
    check("(3) FIX: NO recycle_failed event was fabricated for M2's own teardown-into-M3",
      db.listEventsForWorker(mgr2.id).filter((e) => e.kind === "recycle_failed").length === 0
      && db.listEventsForSession(mgr1Id).filter((e) => e.kind === "recycle_failed").length === 0);
  }
} finally {
  for (const [repo, wt] of worktreesToClean) { if (wt) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } } try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ } }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a session that is ITSELF mid- or already-recycled into a further successor is never wrongly reconciled: recycleWorker's predecessor is protected by recycleTeardownInFlight (its own onExit is guaranteed to fire before its fresh successor is inserted), recycleManager's predecessor is protected by hasSuccessor(sessionId) alone (its fresh successor is inserted before its old pty is ever touched); a genuinely never-started THIRD generation is still correctly unlinked, touching only its own link and never an earlier, legitimate one in the same chain."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
