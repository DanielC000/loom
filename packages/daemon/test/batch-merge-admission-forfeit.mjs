import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 627b38c7 — ADMISSION-TIME BATCH FORFEIT: a merge_batch now re-checks canonical main's HEAD at GATE
// ADMISSION (inside the per-repo merge-admission guard), not only at the END of the gate
// (fastForwardCanonicalMain's own pre-existing check, exercised by batch-merge-gate-retry-forfeit.mjs's
// (vii)/(viii) scenarios, which this file does not duplicate). Three scenarios:
//   (A) main advances AFTER the batch worktree is cut but BEFORE gate admission settles — the batch
//       forfeits WITHOUT ever spawning the real gate command (never even the FIRST attempt), each
//       candidate is handed to its own solo worker_merge_confirm fallback (which DOES still gate — that's
//       the correct, expected behavior for a fallback), and the merge-gate interval state is untouched.
//   (B) main unmoved — the batch gates normally (negative control for the admission check itself).
//   (C) the admission-time HEAD read fails — falls back to running the real gate, exactly like today,
//       never fabricating a forfeit (or a pass).
// Hermetic, no daemon. Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/batch-merge-admission-forfeit.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { awaitTrackedSettle } from "./_settle-tracked-monotonic.mjs";

useOwnLoomHome("loom-bmaf-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=bmaf@loom -c user.name=bmaf";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const dbs = [];
const worktrees = [];

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# bmaf\n");
  execSync(`git init -q && git config user.email bmaf@loom && git config user.name bmaf`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

async function cutBranch(repo, projId, label, file, content) {
  const taskId = `bmaf-task-${label}-${sfx}`;
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, file), content);
  commitAll(worktreePath, `${label}`, GIT_ID);
  return { taskId, branch, worktreePath };
}

function setupBatchProject(label, gateCommand) {
  const projId = `bmaf-${label}-proj-${sfx}`, agentId = `bmaf-${label}-agent-${sfx}`, mgrId = `bmaf-${label}-mgr-${sfx}`;
  const repo = path.join(os.tmpdir(), `loom-bmaf-${label}-${sfx}`);
  return { projId, agentId, mgrId, repo, gateCommand };
}

async function seedTwoWorkers(db, P) {
  makeRepo(P.repo);
  db.insertProject({ id: P.projId, name: `BMAF-${P.projId}`, repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: P.gateCommand } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: P.agentId, projectId: P.projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const a = await cutBranch(P.repo, P.projId, `${P.projId}-a`, "feature-a.txt", "work a\n");
  const b = await cutBranch(P.repo, P.projId, `${P.projId}-b`, "feature-b.txt", "work b\n");
  const wA = `${P.projId}-wkr-a`, wB = `${P.projId}-wkr-b`;
  for (const [wId, w] of [[wA, a], [wB, b]]) {
    db.insertTask({ id: w.taskId, projectId: P.projId, title: `feat(test): ${w.taskId}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: wId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch });
  }
  return { wA, wB, worktreePaths: [a.worktreePath, b.worktreePath] };
}

// Mirrors test/_late-commit-seam.mjs's `lateCommitBeforeSquashTarget` pattern, but targets the BATCH
// admission-time forfeit check's own combined HEAD read (readHeadShaAndBranch's
// ["rev-parse","HEAD","--symbolic-full-name","HEAD"] call via fastForwardCanonicalMain), scoped to
// `canonicalRepoPath` only. ONE-SHOT: `onFirstMatch` fires on the FIRST matching call only — the exact
// admission-time read, since nothing else in the batch flow issues this exact combined args shape against
// the canonical repo before it (the earlier advisory pre-assembly read is a bare `["rev-parse","HEAD"]`,
// a different shape). A LATER matching call (the end-of-gate fastForwardCanonicalMain re-read, reached
// only when the admission check itself does NOT forfeit) always passes straight through to the real read
// — so scenario (B)/(C)'s own end-of-gate check is never intercepted, only its own admission-time read is.
function oneShotCanonicalHeadReadHook(canonicalRepoPath, onFirstMatch) {
  const state = { fired: 0 };
  const factory = (repoPath, blockTimeoutMs) => ({
    raw: async (args) => {
      const { boundedSimpleGit } = await import("../dist/git/bounded.js");
      const { nonInteractiveEnv } = await import("../dist/git/writer.js");
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      const isTargetRead = repoPath === canonicalRepoPath && Array.isArray(args) && args.length === 4
        && args[0] === "rev-parse" && args[1] === "HEAD" && args[2] === "--symbolic-full-name" && args[3] === "HEAD";
      if (isTargetRead && state.fired === 0) {
        state.fired++;
        return onFirstMatch(real, args);
      }
      return real.raw(args);
    },
  });
  return { factory, firedCount: () => state.fired };
}

try {
  // ── (A) ADMISSION FORFEIT — main advances after cut, before admission; gate never spawns ──────────────
  {
    const P = setupBatchProject("admforfeit", "pnpm gate");
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const gateCalls = [];
    // Card 627b38c7 DoD: the BATCH's own gate command must NEVER be invoked — but each forfeited
    // candidate's own solo worker_merge_confirm FALLBACK legitimately re-gates individually, and that is
    // a DIFFERENT, expected call. Distinguish them by worktreePath: the batch's own gate call would run in
    // a dedicated `batch-<opId>` worktree (never one of the two workers' own paths below).
    const { factory: hookFactory, firedCount } = oneShotCanonicalHeadReadHook(P.repo, async (real, args) => {
      // Simulates a REAL concurrent solo landing moving canonical main between this batch's worktree cut
      // and its own gate admission — a plain commit directly onto the canonical repo's working tree,
      // bypassing the batch entirely, exactly like (vii)/(viii)'s own "someone else landed" simulation,
      // just timed to fire BEFORE the gate ever spawns rather than while it runs.
      fs.writeFileSync(path.join(P.repo, "concurrent-main-advance.txt"), "someone else landed before admission\n");
      commitAll(P.repo, "concurrent landing before admission", GIT_ID);
      return real.raw(args); // the REAL post-commit read — reflects the just-advanced HEAD.
    });
    const fakeGate = async (gate, worktreePath) => { gateCalls.push(worktreePath); return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate, batchFfGitFactory: hookFactory });
    const { wA, wB, worktreePaths } = await seedTwoWorkers(db, P);
    worktrees.push(...worktreePaths);

    const before = db.getMergeGateState(P.projId, "primary");
    const r = await awaitTrackedSettle(() => sessions.mergeBatchTracked(P.mgrId, [wA, wB]), { label: "(A) admission-forfeit batch", timeoutMs: 240_000, pendingOps: sessions.pendingOps });
    const after = db.getMergeGateState(P.projId, "primary");

    check("(A) the admission-read hook fired exactly once", firedCount() === 1);
    check("(A) settled ok (mergeBatchTracked itself never rejects)", r.settled === true && r.ok === true);
    const value = r.value;
    check("(A) batch outcome is ok:false (forfeited)", !!value && value.ok === false);
    check("(A) the reason names the forfeit (canonical main advanced)", typeof value?.reason === "string" && value.reason.includes("canonical main advanced"));
    check("(A) nothing landed", Array.isArray(value?.landed) && value.landed.length === 0);
    check("(A) the BATCH's own gate command was NEVER invoked (no call ran in a batch-* worktree)", gateCalls.every((wt) => wt === worktreePaths[0] || wt === worktreePaths[1]));
    check("(A) exactly 2 gate calls total — ONLY the two candidates' own solo fallback confirms", gateCalls.length === 2);
    check("(A) candidate A's own fallback re-gated (worktree present among the gate calls)", gateCalls.includes(worktreePaths[0]));
    check("(A) candidate B's own fallback re-gated too", gateCalls.includes(worktreePaths[1]));
    // Per-repo guard / cap released cleanly on the admission throw: the two fallback confirms above each
    // took their OWN admission on the SAME repoPath, immediately after the forfeit, and both completed —
    // if the guard had stuck, either fallback would have hung inside this same awaitTrackedSettle call.
    check("(A) a subsequent solo admission on the same repo proceeded (both fallbacks completed, no hang)", gateCalls.length === 2);

    const opId = value?.opId;
    check("(A) a build_gate tombstone opId was minted", typeof opId === "string" && opId.length > 0);

    // `lastPassAt`/`lastPassSha` LEGITIMATELY change here — each of the two fallback candidates lands via
    // its OWN real, passing solo gate (applyGatePass), which is correct and unrelated to this card.
    // Code Review (fe50bf38): under this project's own DEFAULT cadence ("every", no mergeGateInterval
    // configured), `gateOwed`/`lastFailure` are BOTH structurally unable to distinguish "no red recorded"
    // from "a red WAS recorded, then immediately overwritten by the two fallback passes" — applyGateFail's
    // own `gateOwed: state.gateOwed || p.periodic` is a no-op under `periodic:false`, and applyGatePass
    // unconditionally resets `lastFailure:null` right after. Reproduced directly: a return-not-throw
    // regression (the exact false-red bug this card's design avoids) still passes both checks below.
    // The field a FAIL writes that a PASS does NOT clear under `periodic:false` is `recent` — applyGateFail
    // pushes to it UNCONDITIONALLY, while applyGatePass's own push is gated on `periodic` (false here) — so
    // a real false-red survives as a `result:"fail"` entry in `after.recent` even after the two fallback
    // passes. This is the check that actually distinguishes the two states; see scenario (A2) below for the
    // sibling proof under a cadence where `gateOwed` itself is live.
    check("(A) no false RED from the admission forfeit: gateOwed stays false", before.gateOwed === false && after.gateOwed === false);
    check("(A) no false RED from the admission forfeit: lastFailure stays null", before.lastFailure === null && after.lastFailure === null);
    check("(A) THE DISCRIMINATING CHECK: no result:\"fail\" entry for this op ever lands in `recent`, even transiently (survives the fallback's own passes under periodic:false)", !after.recent.some((entry) => entry.result === "fail" && entry.opId === opId));
    check("(A) no false ungated-pass counted FOR THE BATCH ITSELF (ungatedSinceLastPass unchanged by the forfeit)", before.ungatedSinceLastPass === after.ungatedSinceLastPass);

    // Code Review (fe50bf38): disabling batch-merge.ts's `forfeitedAtAdmission` mapping (so this result
    // falls into the generic `gateFailed` branch instead) left every check above still green — `ok:false`,
    // the reason text, `landed:[]`, and the gate-call-count/gate_status assertions are all identical either
    // way, since none of them depends on WHICH RunBatchedMergeResult shape produced them. The one thing
    // that mapping is responsible for is this durable event — it only fires from mergeBatchTracked's own
    // `if (result.forfeited)` branch, which that mapping is what sets `forfeited:true` for.
    const forfeitEvent = db.getLatestEventForManagerByKind(P.mgrId, "batch_merge_forfeited");
    check("(A) THE DISCRIMINATING CHECK: a batch_merge_forfeited event was filed for this op (proves the runBatchedMerge forfeitedAtAdmission mapping actually ran, not just the generic gateFailed path)", !!forfeitEvent && forfeitEvent.detail?.opId === opId);

    if (opId) {
      const st = sessions.gateStatus(opId);
      check("(A) gate_status(opId) settles (never lingers running/queued)", st?.state === "settled");
      const row = db.listPendingGateOps().find((x) => x.opId === opId);
      check("(A) the durable row's verdict kind is \"skipped\" (the gate genuinely never ran — never \"fail\")", row?.verdict === "skipped");
      check("(A) the verdict's skipReason names the admission forfeit specifically", row?.verdictPayload?.skipReason === "forfeited-at-admission");
      check("(A) batchBranchCount survives as the REAL assembled count (2), never falsified to 0", row?.verdictPayload?.batchBranchCount === 2);
      check("(A) batchLanded:false — the separate, later fact that nothing actually landed", row?.verdictPayload?.batchLanded === false);
    }
  }

  // ── (A2) ADMISSION FORFEIT UNDER AN INTERVAL CADENCE — makes gateOwed itself a LIVE, reachable field ──
  //     (A)'s own gateOwed/lastFailure checks are structurally blind under the DEFAULT "every" cadence
  //     (periodic:false there, so a real red can never set gateOwed regardless of this card's fix). This
  //     variant configures mergeGate:"off" + mergeGateInterval:1 so K=2 candidates genuinely trip
  //     "interval-due" (periodic:true) — the SAME admission-time forfeit, but now under the one cadence
  //     where a false red WOULD actually flip gateOwed true, making that assertion non-vacuous.
  {
    const P = setupBatchProject("admforfeitinterval", "pnpm gate");
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const gateCalls = [];
    const fakeGate = async (gate, worktreePath) => { gateCalls.push(worktreePath); return { passed: true }; };
    const { factory: hookFactory, firedCount } = oneShotCanonicalHeadReadHook(P.repo, async (real, args) => {
      fs.writeFileSync(path.join(P.repo, "concurrent-main-advance.txt"), "someone else landed before admission\n");
      commitAll(P.repo, "concurrent landing before admission", GIT_ID);
      return real.raw(args);
    });
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate, batchFfGitFactory: hookFactory });
    makeRepo(P.repo);
    db.insertProject({ id: P.projId, name: `BMAF-${P.projId}`, repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: P.gateCommand, mergeGate: "off", mergeGateInterval: 1 } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: P.agentId, projectId: P.projId, name: "dev", startupPrompt: "", position: 0 });
    db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const a = await cutBranch(P.repo, P.projId, `${P.projId}-a`, "feature-a.txt", "work a\n");
    const b = await cutBranch(P.repo, P.projId, `${P.projId}-b`, "feature-b.txt", "work b\n");
    const wA = `${P.projId}-wkr-a`, wB = `${P.projId}-wkr-b`;
    for (const [wId, w] of [[wA, a], [wB, b]]) {
      db.insertTask({ id: w.taskId, projectId: P.projId, title: `feat(test): ${w.taskId}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      db.insertSession({ id: wId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch });
    }
    worktrees.push(a.worktreePath, b.worktreePath);

    const before = db.getMergeGateState(P.projId, "primary");
    const r = await awaitTrackedSettle(() => sessions.mergeBatchTracked(P.mgrId, [wA, wB]), { label: "(A2) admission-forfeit-under-interval batch", timeoutMs: 240_000, pendingOps: sessions.pendingOps });
    const after = db.getMergeGateState(P.projId, "primary");

    check("(A2) the admission-read hook fired exactly once", firedCount() === 1);
    check("(A2) settled ok", r.settled === true && r.ok === true);
    const value2 = r.value;
    check("(A2) batch outcome is ok:false (forfeited)", !!value2 && value2.ok === false);
    // NOTE: unlike (A), this project's own interval=1 means each K=1 FALLBACK confirm re-decides
    // independently (the batch's own K=2 decision is never threaded onto an admission-forfeited
    // candidate) — the first lands ungated (0+1>1 is false), the second then gates for real
    // (1+1>1 is true) — so gateCalls.length here is 1, not 2; that is correct interval behavior, not
    // a bug, and is not what this scenario is testing. What matters is the BATCH's own decision (K=2
    // against interval=1, computed once at admission) is periodic — proven by the mutation-based RED
    // check (CLAUDE.md DoD), not by a brittle runtime count of what each independent fallback does.
    const opId2 = value2?.opId;
    // CORRECTION, found by actually running the required RED-proof mutation against THIS variant too
    // (not just asserted from theory): gateOwed/lastFailure stay BLIND here even though periodic:true
    // makes applyGateFail's own `gateOwed: state.gateOwed || p.periodic` live — because `applyGatePass`
    // resets BOTH unconditionally (`gateOwed:false, lastFailure:null`, no periodic gate on the reset side
    // at all), and interval cadence always decides a real K=1 fallback for this 2-candidate setup
    // (0+1>1 is false, 1+1>1 is true — the SECOND fallback genuinely gates and passes), which resets
    // both right back before `after` is ever read. Kept below as a documented, NON-discriminating fact
    // (gateOwed/lastFailure are never left in a visibly-wrong state), not as proof of anything — the
    // checks that actually caught this card's return-not-throw regression, confirmed by the SAME mutation
    // run, are the `recent` push-only-on-fail check and the durable event check right after.
    check("(A2) (non-discriminating, see comment above) gateOwed stays false", before.gateOwed === false && after.gateOwed === false);
    check("(A2) (non-discriminating, see comment above) lastFailure stays null", before.lastFailure === null && after.lastFailure === null);
    check("(A2) THE DISCRIMINATING CHECK: no result:\"fail\" entry for this op lands in recent (survives the fallback's own pass under THIS cadence too)", !after.recent.some((entry) => entry.result === "fail" && entry.opId === opId2));
    const forfeitEvent2 = db.getLatestEventForManagerByKind(P.mgrId, "batch_merge_forfeited");
    check("(A2) THE DISCRIMINATING CHECK: a batch_merge_forfeited event was filed for this op", !!forfeitEvent2 && forfeitEvent2.detail?.opId === opId2);
  }

  // ── (B) UNMOVED MAIN — negative control: the admission check must not false-positive ────────────────
  {
    const P = setupBatchProject("unmoved", "pnpm gate");
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let gateCalls = 0;
    const fakeGate = async () => { gateCalls++; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { wA, wB, worktreePaths } = await seedTwoWorkers(db, P);
    worktrees.push(...worktreePaths);

    const r = await awaitTrackedSettle(() => sessions.mergeBatchTracked(P.mgrId, [wA, wB]), { label: "(B) unmoved-main batch", timeoutMs: 240_000, pendingOps: sessions.pendingOps });
    check("(B) settled ok", r.settled === true && r.ok === true);
    check("(B) the batch gate DID run (the one real attempt for the batch itself)", gateCalls === 1);
    check("(B) the batch landed normally", r.value?.ok === true && Array.isArray(r.value?.landed) && r.value.landed.length === 2);
  }

  // ── (C) ADMISSION-TIME READ FAILURE — falls back to the real gate, never fabricates a forfeit/pass ──
  {
    const P = setupBatchProject("readfail", "pnpm gate");
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let gateCalls = 0;
    const fakeGate = async () => { gateCalls++; return { passed: true }; };
    const { factory: hookFactory, firedCount } = oneShotCanonicalHeadReadHook(P.repo, async () => {
      throw new Error("simulated admission-time HEAD read failure (card 627b38c7 scenario C)");
    });
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate, batchFfGitFactory: hookFactory });
    const { wA, wB, worktreePaths } = await seedTwoWorkers(db, P);
    worktrees.push(...worktreePaths);

    // Code Review (fe50bf38): the admission check's own console.warn fallback never fired for THIS exact
    // scenario before the fix — `fastForwardCanonicalMain` catches its own internal git read failure and
    // returns `{ok:false}` (never a throw), so the code's try/catch block's catch was dead for this case.
    // Captures real console.warn output (never a mock of the log function itself) to prove the fix.
    const warnLines = [];
    const realWarn = console.warn;
    console.warn = (...args) => { warnLines.push(args.join(" ")); realWarn(...args); };
    let r;
    try {
      r = await awaitTrackedSettle(() => sessions.mergeBatchTracked(P.mgrId, [wA, wB]), { label: "(C) admission-read-failure batch", timeoutMs: 240_000, pendingOps: sessions.pendingOps });
    } finally {
      console.warn = realWarn;
    }
    check("(C) the admission-read hook fired exactly once (the induced failure)", firedCount() === 1);
    check("(C) settled ok", r.settled === true && r.ok === true);
    check("(C) falls back to the real gate — it DID run (no fabricated forfeit)", gateCalls === 1);
    check("(C) the batch landed normally — no fabricated pass either, just today's unaffected behavior", r.value?.ok === true && Array.isArray(r.value?.landed) && r.value.landed.length === 2);
    check("(C) THE DISCRIMINATING CHECK: the read failure was actually LOGGED (the non-fatal fallback is observable, not silently absorbed)", warnLines.some((l) => l.includes("admission-time forfeit check") && l.includes("failed to read canonical HEAD")));
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
