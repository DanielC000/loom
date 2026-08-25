import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// run_gate RESULT-CONSUMPTION FIX (card 50c1e0d0, origin finding c7492bde): the pending note used to read
// "re-call run_gate to fetch the result once ready" — true only WHILE the gate is running. Three faces:
//   1) a re-call AFTER settle started a brand-new run instead of returning the cached result (this file's
//      scenario (A));
//   2) a re-call WHILE the gate is still running silently attached to the stale op with no signal that the
//      worktree had since changed (this file's scenario (B));
//   3) nothing recorded which worktree HEAD a gate actually validated.
// Fix: PendingOpRegistry.attach's opt-in retention (the SAME mechanism confirmWorkerMergeTracked already
// uses — see MERGE_OP_RETAIN_MS) now also covers "gate" ops (GATE_OP_RETAIN_MS), and runWorkerGate stamps
// the worktree's HEAD/dirty state at the moment a run genuinely starts (WorktreeGateStamp), so a re-call
// can report `attachedToInFlight`/`staleAgainstWorktree`, and a settled result carries `validatedHead`.
//
// This file drives the REAL runWorkerGate (an injected `runGate` seam controls TIMING only — never git),
// against a REAL git worktree (via createWorktree), so the worktree-stamp comparisons are exercised for
// real, not faked.
//
// Asserts:
//   (A) a re-call within the settle-grace window returns the SAME settled result (same opId) with NO
//       second gate invocation.
//   (B) a re-call while the gate is still running reports attachedToInFlight:true, and — after the
//       worktree is edited mid-flight — staleAgainstWorktree:true.
//   (C) card 79b0ee52 — once a run SETTLES already known-contaminated (headCurrent:false, the RACY shape:
//       the worktree moved WHILE the gate was actually running), a re-call within the SAME settle-grace
//       window this file's scenario (A) proves reuses a cached result for must NOT reuse that contaminated
//       result — it must mint a genuinely fresh gate run against the current tree instead. This is the
//       literal step-3 failure from the observed live sequence this card documents.
// Run: 1) build daemon (pnpm build), 2) node test/run-gate-result-consumption.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-rgc-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, removeWorktree, computeWorktreeGateStamp } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Retrofitted onto the shared _wait.mjs waitUntil (card 24d2e0ac): same timeoutMs/intervalMs budget
// (still monotonic — the shared helper uses performance.now() internally too), still does a final
// `predicate()` re-check on timeout (unchanged) instead of hardcoding false.
async function waitUntil(predicate, timeoutMs, intervalMs = 100) {
  try {
    return await sharedWaitUntil(predicate, { timeoutMs, intervalMs, label: "run-gate-result-consumption: predicate" });
  } catch (err) {
    if (!/waitUntil: timed out/.test(err?.message ?? "")) throw err;
    return predicate();
  }
}
const GIT_ID = "-c user.email=rgc@loom -c user.name=rgc";
const now = new Date().toISOString();
const ptyStub = () => ({ stop() {}, isAlive() { return false; }, enqueueStdin() {} });

const worktrees = [];
const dbs = [];
try {
  // ── (A) settle-grace re-call returns the SAME settled result, with NO second gate run ────────────────
  {
    const repo = path.join(os.tmpdir(), `loom-rgc-repo-a-${Date.now()}-${process.pid}`);
    registerForCleanup(repo); // this file's own cleanup only rmSync's LOOM_HOME, never this separate repo dir
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, "README.md"), "# rgc\n");
    execSync(`git init -q && git config user.email rgc@loom && git config user.name rgc && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });

    const db = new Db();
    dbs.push(db);
    const P = "rgc-a", workerId = "rgc-a-wkr";
    const { worktreePath, branch } = await createWorktree(repo, P, "t-a");
    worktrees.push([repo, worktreePath]);
    db.insertProject({ id: P, name: "RGC-A", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-dev`, projectId: P, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId: null, worktreePath, branch });

    let gateCalls = 0;
    const fastGate = async () => { gateCalls++; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub(), new OrchestrationControl(), { runGate: fastGate });

    const r1 = await sessions.runWorkerGate(workerId);
    check("(A) first call settles inline and passes", r1.settled === true && r1.ok === true && r1.value.passed === true);
    check("(A) exactly one gate invocation so far", gateCalls === 1);
    const opId1 = r1.value.opId;

    // Re-call immediately — comfortably inside GATE_OP_RETAIN_MS (5s).
    const r2 = await sessions.runWorkerGate(workerId);
    check("(B setup skip) re-call settles", r2.settled === true && r2.ok === true);
    check("(A) the re-call returns the SAME cached opId (served from the retention window)", r2.value.opId === opId1);
    check("(A) NO second gate invocation was triggered by the re-call", gateCalls === 1);
    check("(A) the settled result carries a validatedHead", typeof r1.value.validatedHead === "string" && r1.value.validatedHead.length > 0);
  }

  // ── (B) mid-flight re-call: attachedToInFlight + staleAgainstWorktree after an edit ────────────────────
  {
    const repo = path.join(os.tmpdir(), `loom-rgc-repo-b-${Date.now()}-${process.pid}`);
    registerForCleanup(repo); // this file's own cleanup only rmSync's LOOM_HOME, never this separate repo dir
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, "README.md"), "# rgc\n");
    execSync(`git init -q && git config user.email rgc@loom && git config user.name rgc && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });

    const db = new Db();
    dbs.push(db);
    const P = "rgc-b", workerId = "rgc-b-wkr";
    const { worktreePath, branch } = await createWorktree(repo, P, "t-b");
    worktrees.push([repo, worktreePath]);
    db.insertProject({ id: P, name: "RGC-B", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-dev`, projectId: P, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId: null, worktreePath, branch });

    // CALIBRATED MARGIN, NOT A GUESSED CONSTANT (card f33830d1 — a fixed `syncAttachBudgetMs: 100` was
    // losing this exact race deterministically on GH Actions' `ubuntu-latest` runner, 7/7 CI runs).
    // runWorkerGate computes a REAL WorktreeGateStamp TWICE before the gate is ever entered — once for
    // `startStamp` (before the semaphore), once for `admitStamp` (inside it, right before the injected
    // `runGate` is invoked — service.ts ~11966-12012) — each a real `git rev-parse`/`git status
    // --porcelain`[/`git diff HEAD`] subprocess round trip. The ORIGINATING call's own internal
    // `attach()` race (`Promise.race([e.settle, sleep(waitMs)])`, pending-ops.ts ~705) starts ticking at
    // essentially t≈0, independent of that work, so `waitMs` has to outlast BOTH real round trips — not
    // just one — for that call's post-race staleness read to land after the mid-flight edit below. Get
    // this wrong in EITHER direction and the assertion below stops meaning what it says: too small, and
    // `gateStartStamps` isn't even populated yet when the race resolves, so `gateStampsDiffer`'s fail-safe
    // `startStamp ? … : true` (service.ts ~12358) trivially returns `true` — the assertion PASSES for the
    // wrong reason, without ever comparing real stamps (reproduced locally: on a dev box where a single
    // round trip alone runs ~140ms, `syncAttachBudgetMs: 100` NEVER exercises the real comparison at all);
    // too big, and the call reads its own currentStamp only after the edit has safely landed regardless
    // (also a pass, also not what card 50c1e0d0 set out to prove: that a call whose OWN sync-wait is what
    // straddles the edit — not one that started waiting comfortably after it — still reports correctly).
    // A hand-picked constant that happens to survive TODAY's host is exactly the "generous timeout masking
    // a real inter-scenario dependency" anti-pattern (card c062a307) — it silently breaks again the moment
    // stamp computation gets slower than whatever was guessed, which is precisely what broke on CI, and a
    // merely-bigger guess only defers. Instead: MEASURE the real cost of this exact operation against THIS
    // worktree, live, right now — a signal, not a guess, the same "observe reality instead of assuming
    // timing" discipline this block's own `gateEnteredSignal` below already applies to an EVENT, just
    // applied here to a DURATION. A slower/loaded host measures a bigger number and gets a proportionally
    // bigger budget automatically; a fast one gets a small one — neither is hand-tuned.
    const calibrationStart = performance.now();
    await computeWorktreeGateStamp(worktreePath);
    await computeWorktreeGateStamp(worktreePath);
    const measuredDoubleStampMs = performance.now() - calibrationStart;
    // 3x the measured cost of the two real round trips runWorkerGate itself performs, plus a floor for a
    // host fast enough to measure near-zero — comfortable headroom against run-to-run jitter without
    // reintroducing a fixed "big enough to survive forever" guess.
    const syncAttachBudgetMs = Math.max(60, Math.ceil(measuredDoubleStampMs * 3));
    // `slowGate`'s own hold must comfortably outlast `syncAttachBudgetMs`, scaled off the same live
    // measurement, or the gate could actually SETTLE before the timeout fires and both calls would
    // observe `settled:true` instead of the `pending` shape this scenario exists to exercise.
    const slowGateDelayMs = Math.max(400, syncAttachBudgetMs * 3);

    // Bounded gate-entry SIGNAL, not a blind sleep (card 47a515ff — 5th instance of this file's blind-
    // sleep class in one day): in runWorkerGate, `computeWorktreeGateStamp` is awaited — and its result
    // stored into `gateStartStamps` — strictly BEFORE `runGateSeq` (this injected `runGate`) is ever
    // invoked (service.ts ~8003-8004 vs ~8022-8026, the latter inside `gateSemaphore.runExclusive`).
    // That's a real happens-before in the PRODUCT code, not an assumption we're hoping holds: by the time
    // `slowGate` below is entered, the worktree stamp is guaranteed already recorded. So resolving a
    // signal on entry and awaiting THAT — instead of timing how long stamp-recording takes — makes the
    // ordering exact rather than merely-usually-early-enough.
    //
    // A DEFERRED signal, not a rendezvous BARRIER (contrast gate-semaphore-concurrency.mjs scenario (B),
    // card 595aad10): a barrier proves TWO INDEPENDENT calls genuinely overlap — a symmetric 2-arrival
    // race where neither side has a natural ordering over the other. Here there is only ONE call whose
    // OWN internal ordering (stamp-then-invoke) is already happens-before guaranteed by the product code
    // — there's nothing to race, only a single point to observe. A barrier here would assume a race that
    // doesn't exist; picking the wrong primitive still "passes" but tests something other than what the
    // assertion claims.
    //
    // Bounded (not unbounded): `slowGate` runs inside `gateSemaphore.runExclusive` — if the semaphore is
    // ever held elsewhere, entry could be delayed arbitrarily, and an unbounded await would HANG this
    // test instead of failing it (a hang burns the whole suite's timeout and reports nothing useful).
    // GATE_ENTRY_BOUND_MS is deliberately generous — it costs nothing on the pass path, which resolves
    // near-instantly — and the timeout message below names both plausible causes so a red here is
    // diagnosable, not ambiguous (mirrors 595aad10's own bounded-barrier timeout message).
    const GATE_ENTRY_BOUND_MS = 8000;
    let gateEntered;
    const gateEnteredSignal = new Promise((resolve) => { gateEntered = resolve; });
    const slowGate = async () => { gateEntered(); await sleep(slowGateDelayMs); return { passed: true }; };
    const sessions = new SessionService(db, ptyStub(), new OrchestrationControl(), { runGate: slowGate, syncAttachBudgetMs });

    const p1 = sessions.runWorkerGate(workerId); // don't await — runs in the background
    const enteredInTime = await Promise.race([
      gateEnteredSignal.then(() => true),
      sleep(GATE_ENTRY_BOUND_MS).then(() => false),
    ]);
    check(
      enteredInTime
        ? "(B) setup: the gate was entered within the bound (the worktree stamp is now guaranteed recorded)"
        : `(B) setup: the gate was never entered within ${GATE_ENTRY_BOUND_MS}ms — either gate-semaphore contention delayed entry, or the stamp-then-invoke ordering in runWorkerGate has regressed (see service.ts ~8000-8026; GATE_ENTRY_BOUND_MS is deliberately generous, so rule out host load before suspecting the ordering)`,
      enteredInTime,
    );

    // Simulate "the worker edited the test after starting the gate" — an uncommitted edit to an EXISTING
    // tracked file (the origin finding's exact scenario), no commit.
    fs.appendFileSync(path.join(worktreePath, "README.md"), "edited mid-gate\n");

    const r2 = await sessions.runWorkerGate(workerId); // attaches to the SAME in-flight op
    check("(B) the re-call degrades to pending (gate still running)", r2.settled === false);
    check("(B) attachedToInFlight is true (this call did NOT start the op)", r2.attachedToInFlight === true);
    check("(B) staleAgainstWorktree is true (worktree edited since the run started)", r2.staleAgainstWorktree === true);

    const r1 = await p1;
    check("(B) the ORIGINATING call also degraded to pending (gate genuinely slow)", r1.settled === false);
    check("(B) the originating call reports attachedToInFlight:false (it minted the op itself)", r1.attachedToInFlight === false);
    // Code Review hardening (card 50c1e0d0): staleAgainstWorktree is independent of attachedToInFlight —
    // the ORIGINATING call's own pending check is computed AFTER its own sync-wait elapses, by which point
    // the mid-flight edit above has already happened, so it must ALSO report staleAgainstWorktree:true,
    // not just the re-call that attached to it.
    check("(B) the ORIGINATING call ALSO reports staleAgainstWorktree:true (edited during its own sync-wait)", r1.staleAgainstWorktree === true);
    check("(B) both calls report the SAME opId", r1.op.opId === r2.op.opId);

    // Let the real op actually settle so nothing dangles past this block.
    await waitUntil(() => sessions.pendingOps.peek(`gate:${workerId}`)?.state !== "running", 20_000);
  }

  // ── (C) card 79b0ee52: a settled result already known CONTAMINATED (headCurrent:false, RACY shape) is
  //     NEVER re-served from the retention cache — a re-call within the SAME grace window scenario (A)
  //     proves reuses a result for must instead mint a genuinely fresh gate run ─────────────────────────
  {
    const repo = path.join(os.tmpdir(), `loom-rgc-repo-c-${Date.now()}-${process.pid}`);
    registerForCleanup(repo); // this file's own cleanup only rmSync's LOOM_HOME, never this separate repo dir
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, "README.md"), "# rgc\n");
    execSync(`git init -q && git config user.email rgc@loom && git config user.name rgc && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });

    const db = new Db();
    dbs.push(db);
    const P = "rgc-c", workerId = "rgc-c-wkr";
    const { worktreePath, branch } = await createWorktree(repo, P, "t-c");
    worktrees.push([repo, worktreePath]);
    db.insertProject({ id: P, name: "RGC-C", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-dev`, projectId: P, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId: null, worktreePath, branch });

    let gateCalls = 0;
    // Simulates "the worktree moved WHILE the gate was running" from INSIDE the injected gate step itself
    // — an uncommitted edit to an EXISTING tracked file, made strictly between runWorkerGate's `admitStamp`
    // (taken right before this function is invoked, inside gateSemaphore.runExclusive) and its
    // `settleStamp` (taken right after this function resolves) — exactly the window
    // describeGateHeadCurrency reads as the RACY headCurrent:false shape (service.ts ~7680-7684), the same
    // shape the origin observed sequence hit ("that op settled — contaminated, headCurrent: false").
    const contaminatingGate = async () => {
      gateCalls++;
      fs.appendFileSync(path.join(worktreePath, "README.md"), `edit ${gateCalls}\n`);
      return { passed: true };
    };
    const sessions = new SessionService(db, ptyStub(), new OrchestrationControl(), { runGate: contaminatingGate });

    const r1 = await sessions.runWorkerGate(workerId);
    check("(C) setup: first run settles inline and passes", r1.settled === true && r1.ok === true && r1.value.passed === true);
    check("(C) setup: first run settled CONTAMINATED (headCurrent:false) — the edit landed during the run itself", r1.value.headCurrent === false);
    check("(C) setup: exactly one gate invocation so far", gateCalls === 1);
    const opId1 = r1.value.opId;

    // Re-call immediately — comfortably inside GATE_OP_RETAIN_MS (5s), the SAME window scenario (A) proves
    // reuses a cached result for. Before card 79b0ee52 this returned the SAME contaminated result (same
    // opId, no second invocation) straight out of the retention cache — the literal step-3 bug.
    const r2 = await sessions.runWorkerGate(workerId);
    check("(C) THE FIX: a re-call against a KNOWN-CONTAMINATED cached result triggers a genuinely FRESH gate run, not a cache hit", gateCalls === 2);
    check("(C) the fresh run returns a DIFFERENT opId — it is not the stale cached one handed back again", r2.settled === true && r2.ok === true && r2.value.opId !== opId1);
  }
} finally {
  for (const [repo, wt] of worktrees) { if (wt) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } } }
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — run_gate's settle-grace retention window returns a USABLE cached result with no second run, a mid-flight re-call correctly reports attachedToInFlight + staleAgainstWorktree after a worktree edit, and (card 79b0ee52) a re-call against a settled result already known CONTAMINATED (headCurrent:false) never reuses it — it mints a genuinely fresh gate run against the current tree instead."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
