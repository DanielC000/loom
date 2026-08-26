import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// COMPOSER-INTEGRITY WARNING test (card e1ac691b) — `worker_merge_confirm` now surfaces a NON-BLOCKING
// `warning` when the worker it's confirming ever recorded a composer-fusion / prompt-replay / unmatched
// prompt-mismatch / paste-recovery give-up during its life (`Live.lastMismatchReplay`/`lastMismatchFusion`/
// `lastMismatchUnmatched`/`lastPasteTripwireGiveUp`, pty/host.ts). This puts the SAME signal that an
// advisory-only channel (console.warn, an attention-path nudge) has scored ZERO acted-on in front of an
// ACTION a manager was already taking (confirming a merge) — per pinned memory
// `shipping-a-detector-is-not-someone-reading-it`. NON-BLOCKING, ALWAYS: it must never gate/refuse a
// merge — every scenario below that sets a signal still merges (merged:true).
//
// `composerIntegrityWarning` is computed INSIDE the single async operation `confirmWorkerMergeTracked`'s
// `pendingOps.attach()` wraps (`confirmWorkerMerge` / `finishAlreadyMerged`) — baked into the returned
// `ConfirmMergeResult` once, at the moment the merge actually executes. Scenarios (F)/(G) below are the
// direct proof of why that placement matters: correct across all three of worker_merge_confirm's response
// shapes (sync settled, async pending-then-settled, cached-verdict reuse) without extra plumbing.
//
// REAL git on temp repos, mirroring merge-skill-liveness-warning.mjs's in-process style (SessionService
// driven directly, no live daemon, no claude).
//
// Proves:
//   (A) NEGATIVE CONTROL — a green merge with no lastMismatch*/lastPasteTripwireGiveUp signal set carries
//       no composer-integrity text in `warning` at all (stays fully undefined here, since nothing else in
//       this scenario sets a sibling warning either).
//   (B) POSITIVE — a single lastMismatchFusion signal set on the worker's session id: merged:true, and
//       `warning` names it (gen + ISO timestamp), still non-blocking.
//   (C) ALL-FOUR CENSUS, CHRONOLOGICAL — with all four candidate signals set at different detectedAt, the
//       warning names ALL FOUR (never just one), in oldest-first order — CORRECTED from an earlier
//       "most-recent-of-four" design (manager review): picking by recency alone hid a severe candidate
//       behind a merely-more-recent benign one. See (C2) below for the regression case that would have
//       caught that defect directly.
//   (C2) THE ANTI-RECENCY-SELECTION REGRESSION — an OLDER `unmatched` (possible LOSS) alongside a NEWER
//       `fusion` (ESTABLISHED, nothing lost): asserts the severe, OLDER candidate is NOT hidden by the
//       benign, newer one — this is the exact case a "most recent wins" selection would fail: it would
//       surface only the fusion and tell a manager "nothing was lost" while a possible-loss event sat
//       unmentioned. Without this case, a future refactor could silently revert to recency-selection and
//       nothing else in this file would catch it.
//   (D) ALREADY_MERGED path (finishAlreadyMerged) ALSO carries the same warning — a manager confirming an
//       already-landed branch is still taking the merge-confirm ACTION against this same worker.
//   (E) DEFENSIVE GUARD — a minimal ptyStub lacking all four getters (the shape the majority of this
//       suite's existing merge-confirm tests already use) still merges cleanly with NO throw and no
//       composer-integrity contribution to `warning` — proving this card's code did not regress every
//       narrower stub already in this suite.
//   (F) CACHED-VERDICT REUSE — a re-call at the SAME commit returns the CACHED verdict (no second gate
//       run, no freshMint). The warning on the SECOND call is the FROZEN one from the run that actually
//       computed it — even after the underlying pty signal is mutated to a DIFFERENT value in between the
//       two calls, the cached reply still reports the ORIGINAL value, proving it never silently re-reads
//       live state on a cache hit (the manager's own stated risk: "a cached-verdict re-call must not
//       silently emit a stale warning from a previous run").
//   (G) ASYNC PENDING-THEN-SETTLED — a slow gate (held open by a hand-controlled deferred promise) forces
//       confirmWorkerMergeTracked to degrade to {settled:false, status:"pending"}. The pty signal is set
//       BEFORE the gate is released but is NOT read until the op is actually admitted and runs — the
//       settled result (reached once the deferred promise is resolved) carries the warning computed AT
//       THAT TIME, not at the original call's own issuance (the manager's other stated risk: "an async
//       pending settle must not emit one computed at request time").
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-composer-integrity-warning.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup, cleanupPathSync } from "./_tmp-fixture.mjs";
import { deferred, waitUntil } from "./_wait.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mciw-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, mergeBranch } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mciw@loom -c user.name=mciw";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();

function seed(db, p, opts) {
  // `mgrProcessState` defaults to "exited" (the shape every OTHER scenario in this file, and most of this
  // suite's other merge-confirm tests, use — there is no live pty either way, and a single settling call
  // never consults it). Scenario (G) below is the one exception: it re-attaches to a genuinely STILL
  // RUNNING op across several polls, and `confirmWorkerMergeTracked`'s dead-owner recovery (card 27ea069e)
  // would otherwise treat an "exited" manager as dead and evict + re-mint a FRESH confirmWorkerMerge on
  // EVERY poll — a pile-up of concurrent real git-merge attempts on the same branch that never lets any
  // single one settle within its own attach budget. Pass `mgrProcessState: "live"` there.
  db.insertProject({ id: p.projId, name: "MCIW", repoPath: p.repo, vaultPath: p.repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "MCIW-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: opts?.mgrProcessState ?? "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

function makeRepo(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  registerForCleanup(p.repo);
  fs.writeFileSync(path.join(p.repo, "README.md"), "# mciw\n");
  execSync(`git init -q && git config user.email mciw@loom && git config user.name mciw && git add . && git ${GIT_ID} commit -q -m init`, { cwd: p.repo });
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (label) => ({
  projId: `mciw-${label}-proj-${sfx}`, agentId: `mciw-${label}-agent-${sfx}`, taskId: `mciw-${label}-task-${sfx}`,
  mgrId: `mciw-${label}-mgr-${sfx}`, workerId: `mciw-${label}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-mciw-${label}-${sfx}`),
});

// A full ptyStub implementing all four getters, driven by a mutable `signals` object the test controls.
function fullPtyStub(signals) {
  return {
    stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; },
    getLastMismatchReplay(id) { return signals.replay?.[id] ?? null; },
    getLastMismatchFusion(id) { return signals.fusion?.[id] ?? null; },
    getLastMismatchUnmatched(id) { return signals.unmatched?.[id] ?? null; },
    getLastPasteTripwireGiveUp(id) { return signals.tripwire?.[id] ?? null; },
  };
}

const dbs = [];
const worktrees = [];
try {
  // ── (A) NEGATIVE CONTROL — no signal set at all ─────────────────────────────────────────────────────
  {
    const A = mk("a");
    makeRepo(A);
    const db = new Db(); dbs.push(db);
    const pty = fullPtyStub({});
    const sessions = new SessionService(db, pty, new OrchestrationControl(), { runGate: async () => ({ passed: true, steps: [] }) });
    const { worktreePath, branch } = await createWorktree(A.repo, A.projId, A.taskId);
    A.worktreePath = worktreePath; A.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "feat-a.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "feat-a"`, { cwd: worktreePath });
    seed(db, A);

    const confirm = await sessions.confirmWorkerMerge(A.mgrId, A.workerId);
    check("(A) merged:true", confirm.merged === true);
    check("(A) no warning at all — nothing recorded, nothing else in scope to warn about", confirm.warning === undefined);
  }

  // ── (B) POSITIVE — a single composer-fusion signal ──────────────────────────────────────────────────
  {
    const B = mk("b");
    makeRepo(B);
    const db = new Db(); dbs.push(db);
    const signals = { fusion: {} };
    const pty = fullPtyStub(signals);
    const sessions = new SessionService(db, pty, new OrchestrationControl(), { runGate: async () => ({ passed: true, steps: [] }) });
    const { worktreePath, branch } = await createWorktree(B.repo, B.projId, B.taskId);
    B.worktreePath = worktreePath; B.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "feat-b.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "feat-b"`, { cwd: worktreePath });
    seed(db, B);
    signals.fusion[B.workerId] = { gen: 9, spanGens: [7, 8, 9], reportedLen: 100, intendedLen: 40, detectedAt: 1_000_000 };

    const confirm = await sessions.confirmWorkerMerge(B.mgrId, B.workerId);
    check("(B) merged:true — NON-BLOCKING, still merges", confirm.merged === true);
    check("(B) warning classifies it as a composer-FUSION", typeof confirm.warning === "string" && confirm.warning.includes("composer-FUSION"));
    check("(B) warning names the recorded generation", confirm.warning.includes("gen=9"));
    check("(B) warning carries the SCOPE — spanGens, not just a bare gen", confirm.warning.includes("spanning generation(s) 7,8,9"));
    check("(B) warning classifies it as ESTABLISHED (nothing of THIS turn lost)", confirm.warning.includes("ESTABLISHED, nothing of gen=9's own turn was lost"));
    check("(B) warning names the ONE actionable check — the earlier generation(s) to re-verify", confirm.warning.includes("generation(s) 7,8") && confirm.warning.includes("acted on a second time"));
  }

  // ── (C) ALL-FOUR CENSUS, CHRONOLOGICAL — every candidate is named, oldest-first ─────────────────────
  {
    const C = mk("c");
    makeRepo(C);
    const db = new Db(); dbs.push(db);
    const signals = { replay: {}, fusion: {}, unmatched: {}, tripwire: {} };
    const pty = fullPtyStub(signals);
    const sessions = new SessionService(db, pty, new OrchestrationControl(), { runGate: async () => ({ passed: true, steps: [] }) });
    const { worktreePath, branch } = await createWorktree(C.repo, C.projId, C.taskId);
    C.worktreePath = worktreePath; C.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "feat-c.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "feat-c"`, { cwd: worktreePath });
    seed(db, C);
    signals.replay[C.workerId] = { gen: 3, replayedGen: 2, reportedLen: 10, intendedLen: 10, detectedAt: 1_000_000 };
    signals.fusion[C.workerId] = { gen: 5, spanGens: [4, 5], reportedLen: 20, intendedLen: 10, detectedAt: 2_000_000 };
    signals.unmatched[C.workerId] = { gen: 7, intendedLen: 5, intendedText: "x", detectedAt: 3_000_000 };
    signals.tripwire[C.workerId] = { gen: 11, token: "tok", engineSessionId: "eng", detectedAt: 4_000_000 };

    const confirm = await sessions.confirmWorkerMerge(C.mgrId, C.workerId);
    check("(C) merged:true", confirm.merged === true);
    check("(C) warning names ALL FOUR candidates, not just one", ["REPLAY", "composer-FUSION", "UNMATCHED prompt mismatch", "paste-recovery GIVE-UP"].every((s) => confirm.warning.includes(s)));
    check("(C) warning states the count (4)", confirm.warning.includes("recorded 4 composer-integrity events"));
    // CHRONOLOGICAL (oldest-first): replay(1e6) < fusion(2e6) < unmatched(3e6) < tripwire(4e6).
    const order = ["REPLAY", "composer-FUSION", "UNMATCHED prompt mismatch", "paste-recovery GIVE-UP"].map((s) => confirm.warning.indexOf(s));
    check("(C) ordered chronologically, oldest-first — never severity-first, never recency-first", order.every((idx, i) => i === 0 || idx > order[i - 1]));
  }

  // ── (C2) THE ANTI-RECENCY-SELECTION REGRESSION — an older SEVERE candidate must not be hidden by a
  //         newer BENIGN one. This is the exact case that would fail under a "most recent wins" design.
  {
    const C2 = mk("c2");
    makeRepo(C2);
    const db = new Db(); dbs.push(db);
    const signals = { fusion: {}, unmatched: {} };
    const pty = fullPtyStub(signals);
    const sessions = new SessionService(db, pty, new OrchestrationControl(), { runGate: async () => ({ passed: true, steps: [] }) });
    const { worktreePath, branch } = await createWorktree(C2.repo, C2.projId, C2.taskId);
    C2.worktreePath = worktreePath; C2.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "feat-c2.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "feat-c2"`, { cwd: worktreePath });
    seed(db, C2);
    // OLDER, SEVERE: a possible LOSS at gen=4.
    signals.unmatched[C2.workerId] = { gen: 4, intendedLen: 12, intendedText: "y", detectedAt: 1_000_000 };
    // NEWER, BENIGN: an established, nothing-lost fusion at gen=9 — this is what a recency-only
    // selection would surface INSTEAD of the possible loss above.
    signals.fusion[C2.workerId] = { gen: 9, spanGens: [8, 9], reportedLen: 30, intendedLen: 15, detectedAt: 9_000_000 };

    const confirm = await sessions.confirmWorkerMerge(C2.mgrId, C2.workerId);
    check("(C2) merged:true", confirm.merged === true);
    check("(C2) the OLDER, SEVERE possible-LOSS is present — NOT hidden by the newer benign fusion", confirm.warning.includes("UNMATCHED prompt mismatch at gen=4") && confirm.warning.includes("a possible LOSS"));
    check("(C2) the newer benign fusion is ALSO present (a census, not a suppression the other way either)", confirm.warning.includes("composer-FUSION at gen=9"));
    check("(C2) the severe, older one is named FIRST (chronological)", confirm.warning.indexOf("UNMATCHED") < confirm.warning.indexOf("composer-FUSION"));
  }

  // ── (D) ALREADY_MERGED path (finishAlreadyMerged) also carries the warning ─────────────────────────
  {
    const D = mk("d");
    makeRepo(D);
    const db = new Db(); dbs.push(db);
    const signals = { fusion: {} };
    const pty = fullPtyStub(signals);
    const sessions = new SessionService(db, pty, new OrchestrationControl(), { runGate: async () => ({ passed: true, steps: [] }) });
    const { worktreePath, branch } = await createWorktree(D.repo, D.projId, D.taskId);
    D.worktreePath = worktreePath; D.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "feat-d.txt"), "already merged work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "feat-d"`, { cwd: worktreePath });
    seed(db, D);
    signals.fusion[D.workerId] = { gen: 4, spanGens: [3, 4], reportedLen: 50, intendedLen: 20, detectedAt: 1_000_000 };
    // Land the branch OUT-OF-BAND (simulating a merge that already happened) — confirmWorkerMerge should
    // hit finishAlreadyMerged's early idempotency path, not the gate/squash path.
    const landed = await mergeBranch(D.repo, branch, "MCIW already-merged");
    check("(D) precondition: branch landed out-of-band", landed.ok === true);

    const confirm = await sessions.confirmWorkerMerge(D.mgrId, D.workerId);
    check("(D) ALREADY_MERGED → merged:true", confirm.merged === true && confirm.emptyKind === "ALREADY_MERGED");
    check("(D) warning present on the ALREADY_MERGED path too", typeof confirm.warning === "string" && confirm.warning.includes("composer-FUSION"));
  }

  // ── (E) DEFENSIVE GUARD — a minimal ptyStub (this suite's own dominant existing shape) never throws ──
  {
    const E = mk("e");
    makeRepo(E);
    const db = new Db(); dbs.push(db);
    // Deliberately the SAME minimal shape merge-confirm-idempotent.mjs / merge-skill-liveness-warning.mjs
    // / most of this suite's other merge tests already use — no lastMismatch*/lastPasteTripwireGiveUp
    // getters at all.
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: async () => ({ passed: true, steps: [] }) });
    const { worktreePath, branch } = await createWorktree(E.repo, E.projId, E.taskId);
    E.worktreePath = worktreePath; E.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "feat-e.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "feat-e"`, { cwd: worktreePath });
    seed(db, E);

    let threw = false;
    let confirm;
    try { confirm = await sessions.confirmWorkerMerge(E.mgrId, E.workerId); } catch { threw = true; }
    check("(E) a minimal ptyStub missing all four getters does NOT throw", threw === false);
    check("(E) still merges cleanly", confirm?.merged === true);
    check("(E) no composer-integrity text leaks in from an undefined read", confirm?.warning === undefined);
  }

  // ── (F) CACHED-VERDICT REUSE — the second call replays the FROZEN warning, never a live re-read ─────
  {
    const F = mk("f");
    makeRepo(F);
    const db = new Db(); dbs.push(db);
    const signals = { fusion: {} };
    const pty = fullPtyStub(signals);
    const sessions = new SessionService(db, pty, new OrchestrationControl(), { runGate: async () => ({ passed: true, steps: [] }) });
    const { worktreePath, branch } = await createWorktree(F.repo, F.projId, F.taskId);
    F.worktreePath = worktreePath; F.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "feat-f.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "feat-f"`, { cwd: worktreePath });
    seed(db, F);
    signals.fusion[F.workerId] = { gen: 1, spanGens: [0, 1], reportedLen: 30, intendedLen: 10, detectedAt: 1_000_000 };

    const r1 = await sessions.confirmWorkerMergeTracked(F.mgrId, F.workerId);
    check("(F) op 1 settled + merged", r1.settled === true && r1.ok === true && r1.value.merged === true);
    check("(F) op 1 warning names gen=1", r1.ok && r1.value.warning?.includes("gen=1"));
    check("(F) op 1 announces genuinely-new (nothing cached yet)", r1.freshMint?.reason === "genuinely-new");

    // Mutate the LIVE signal to a DIFFERENT value AFTER op 1 ran — simulating a new event on this worker's
    // session happening after the merge. A correct cache hit must NOT pick this up.
    signals.fusion[F.workerId] = { gen: 99, spanGens: [98, 99], reportedLen: 30, intendedLen: 10, detectedAt: 9_000_000 };

    const r2 = await sessions.confirmWorkerMergeTracked(F.mgrId, F.workerId);
    check("(F) op 2 settled, same opId — CACHE HIT (no second gate/merge)", r2.settled === true && r2.ok === true && r2.value.opId === r1.value.opId);
    check("(F) op 2 carries NO freshMint — the cache-hit signal", r2.freshMint === undefined);
    check("(F) op 2's warning is the FROZEN gen=1 from op 1, NOT the mutated gen=99", r2.ok && r2.value.warning?.includes("gen=1") && !r2.value.warning?.includes("gen=99"));
  }

  // ── (G) ASYNC PENDING-THEN-SETTLED — computed when the op actually runs, not at request time ────────
  {
    const G = mk("g");
    makeRepo(G);
    const db = new Db(); dbs.push(db);
    const signals = { fusion: {} };
    const pty = fullPtyStub(signals);
    const gate = deferred(); // the test controls exactly when the "gate" resolves
    const sessions = new SessionService(db, pty, new OrchestrationControl(), {
      runGate: async () => gate.promise,
      syncAttachBudgetMs: 20, // tiny — the deferred gate will not have resolved by the time this elapses
    });
    const { worktreePath, branch } = await createWorktree(G.repo, G.projId, G.taskId);
    G.worktreePath = worktreePath; G.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "feat-g.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "feat-g"`, { cwd: worktreePath });
    seed(db, G, { mgrProcessState: "live" }); // see seed()'s own doc — avoids dead-owner eviction across polls
    // Set the signal BEFORE the call — proving placement-at-run-time (not issuance-time) still reads it
    // correctly once the op actually gets to run, not merely that a LATER mutation is excluded (that's (F)).
    signals.fusion[G.workerId] = { gen: 6, spanGens: [5, 6], reportedLen: 25, intendedLen: 10, detectedAt: 1_000_000 };

    const pending = await sessions.confirmWorkerMergeTracked(G.mgrId, G.workerId);
    check("(G) degrades to pending — the sync budget elapsed before the gate resolved", pending.settled === false);

    gate.resolve({ passed: true, steps: [] }); // release the held gate now
    // The background op (real git squash/finalize work) can easily outlast the SAME tiny 20ms budget on a
    // re-attach — poll (re-attaching to the SAME in-flight op each time, never starting a new one) until
    // it actually settles, rather than assuming one re-call is enough.
    const settled = await waitUntil(async () => {
      const r = await sessions.confirmWorkerMergeTracked(G.mgrId, G.workerId);
      return r.settled ? r : false;
    }, { label: "op G settles after the held gate resolves", timeoutMs: 10_000 });
    check("(G) eventually settles, merged", settled.settled === true && settled.ok === true && settled.value.merged === true);
    check("(G) settled warning names gen=6 — computed when the op actually ran, not at the original request", settled.ok && settled.value.warning?.includes("gen=6"));
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) cleanupPathSync(wt);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_merge_confirm's composerIntegrityWarning: non-blocking, surfaces EVERY recorded composer-fusion/prompt-mismatch/paste-tripwire candidate (never just the most recent — a severe older one is never hidden behind a benign newer one), ordered chronologically, on both the Green and ALREADY_MERGED paths, is silent when nothing was recorded, never throws against a narrower legacy ptyStub, and is computed once (at actual run time) — correct across a cache-hit replay and an async pending-then-settled read alike."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
