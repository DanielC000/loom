import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// ROUND 2 of card afa80698 (Code Reviewer 1267fac2 @ 8c4fa59c, REQUEST-CHANGES), items 2 and 3.
// `merge-prelanded-content-diverged.mjs` proves the MECHANISM directly against `mergeBranch` — this file
// proves the WIRING: that a real `SessionService.confirmWorkerMerge` call, on a genuinely DIRTY-worktree
// preLanded branch, actually reaches that mechanism with `expectAlreadyLanded` set, and that the resulting
// refusal is classified correctly and never cached. Scaffolding (mk/makeRepo/seed/createWorktree/fakeGate)
// mirrors merge-gate-reuse-admission.mjs's own (M)/(N) scenarios — the closest existing precedent for
// driving a dirty-preLanded branch through the real gate path via SessionService.
//
//   (A) CONFIRM-LEVEL WIRING — a human reverts the landed commit before the re-confirm; the worktree is
//       staged dirty-then-clean (see `stageDirtClearedBeforeGateSpawns` below) so `confirmWorkerMerge`
//       skips the clean ALREADY_MERGED shortcut and reaches the real gate path, exactly like production.
//       Asserts `confirm.landedContentDiverged === true` and the reverted content stays absent.
//   (B) NEVER-CACHED — `confirmWorkerMerge` (what (A)/(C) call) is the RAW method; the until-superseded
//       verdict cache lives in `confirmWorkerMergeTracked`'s own `pendingOps.attach()` wrapper, so this
//       scenario goes through THAT real entrypoint instead (self-contained, two tracked calls on the
//       same op). Asserts both structurally (`r2.cacheHit === undefined`) and behaviorally (the fake
//       gate's own call counter increments again) that the second refusal was genuinely re-derived, not
//       replayed from cache.
//   (C) NO-GATECOMMAND PROJECT — card afa80698 round 2 item 3: the SAME dirty-preLanded-then-reverted
//       shape, on a project with NO gateCommand configured at all (the `if (gate)` block that normally
//       derives `expectAlreadyLanded` never runs). Asserts the no-gate-call-site derivation still catches
//       it — `confirm.landedContentDiverged === true`, content stays absent, zero gate calls.
//   (D) RESIDUE-POSSIBLE DETAILTEXT — card fc7827e7 item 1: `merge-prelanded-content-diverged.mjs`'s own
//       scenario (5) pins `mergeBranch`'s raw `reason` for a pre-existing-canonical-dirt residue, but
//       nothing drove that same shape through the real confirm wiring to pin `confirmWorkerMerge`'s own
//       `detailText` (service.ts's `merge.residuePossible ?` ternary) — flipping that ternary stayed
//       green with no confirm-level test touching it. Asserts `confirm.detailText` names the
//       `git diff --cached` remedy and never claims the canonical repo is "untouched".
//
// MANUAL MUTATION PROOFS (not re-run automatically here — a single-assignment source mutation isn't
// expressible as a test case in this same file, same posture as emit-compare-gate-scope-reclassify.mjs's
// own (N) scenario doc): verified by hand once, documented in the commit —
//   - commenting out `expectAlreadyLanded = true;` (the preLanded producer's own assignment, service.ts)
//     turns scenario (A) RED (`confirm.landedContentDiverged` stays `undefined`, the reverted content is
//     silently re-landed instead).
//   - removing `"landed-content-diverged"` from `NEVER_CACHED_OUTCOMES` (pending-ops.ts) turns scenario
//     (B) RED (op 2 comes back with a `cacheHit`, and the fake gate's call count does not increment).
//   - commenting out the `if (!gate && !owedBase) { ... }` derivation (service.ts) turns scenario (C) RED.
//   - flipping `merge.residuePossible ?` (service.ts, the `landedContentDiverged` branch's own
//     `detailText` ternary) turns scenario (D) RED — `detailText` then claims "canonical repo untouched"
//     on exactly the run where the pre-existing canonical dirt left it anything but. RED/GREEN proof:
//     `pnpm --filter @loom/daemon negative-control --file packages/daemon/src/sessions/service.ts --test
//     packages/daemon/test/merge-prelanded-content-diverged-wiring.mjs`.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-prelanded-content-diverged-wiring.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { registerForCleanup, cleanupPathSync } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { settleTracked } from "./_settle-tracked.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-pcdw-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, mergeBranch } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=pcdw@loom -c user.name=pcdw";
const ID_ARGS = GIT_ID.split(" ").filter(Boolean);
const now = new Date().toISOString();

function headSha(repo) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
}
function revert(repo, sha) {
  execFileSync("git", [...ID_ARGS, "revert", "--no-edit", sha], { cwd: repo });
}

// A worktree dirty for the WHOLE confirm trips `@decision 975c774b`'s own "already dirty before the gate
// spawns" refusal (`gateWorktreeDirty`) outright — measured (card afa80698 round 2, first attempt at this
// file): the gate never even spawns, so `expectAlreadyLanded`'s own mechanism is never reached at all.
// To genuinely take the real (not clean-shortcut) path, the worktree must read dirty at the FIRST stamp
// (the preLanded clean-shortcut's own check) and CLEAN at the SECOND (the gate's own before-spawn check) —
// staged deterministically exactly like emit-compare-gate-scope-reclassify.mjs's own (M2) scenario:
// `checkGateTimeoutBreaker` is the one awaited step between the two stamps.
function stageDirtClearedBeforeGateSpawns(sessions, branch, worktreePath) {
  const dirtPath = path.join(worktreePath, "scratch-dirt.txt");
  fs.writeFileSync(dirtPath, "transient\n");
  let racedClean = false;
  const realBreaker = sessions.checkGateTimeoutBreaker.bind(sessions);
  sessions.checkGateTimeoutBreaker = async (...a) => {
    if (!racedClean && a[0] === branch) { racedClean = true; fs.rmSync(dirtPath, { force: true }); }
    return realBreaker(...a);
  };
}

function makeRepo(prefix) {
  const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const repo = path.join(os.tmpdir(), `loom-pcdw-${prefix}-${sfx}`);
  registerForCleanup(repo);
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", [...ID_ARGS, "config", "core.autocrlf", "false"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "# pcdw\n");
  commitAll(repo, "init", GIT_ID);
  return repo;
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (label) => ({
  projId: `pcdw-${label}-proj-${sfx}`, agentId: `pcdw-${label}-agent-${sfx}`, taskId: `pcdw-${label}-task-${sfx}`,
  mgrId: `pcdw-${label}-mgr-${sfx}`, workerId: `pcdw-${label}-wkr-${sfx}`,
});

function seed(db, p, repo, worktreePath, branch, gateCommand) {
  db.insertProject({ id: p.projId, name: "PCDW", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "PCDW-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath, branch });
}

const dbs = [];
const worktrees = [];
try {
  // ── (A) CONFIRM-LEVEL WIRING ─────────────────────────────────────────────────────────────────────
  {
    console.log("\n— (A) confirm-level wiring: dirty-preLanded branch, revert before the re-confirm —");
    const P = mk("a");
    const repo = makeRepo("a");
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const { worktreePath, branch } = await createWorktree(repo, P.projId, P.taskId);
    worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "feature-a.txt"), "work for A\n");
    commitAll(worktreePath, "feature work", GIT_ID);

    const land = await mergeBranch(repo, branch, "feature A landed");
    check("(A) precondition: landed cleanly", land.ok === true);
    const X = headSha(repo);

    revert(repo, X); // lands BEFORE the re-confirm
    check("(A) precondition: the revert landed, feature-a.txt is gone again", !fs.existsSync(path.join(repo, "feature-a.txt")));

    let gateCalls = 0;
    const fakeGate = async () => { gateCalls++; return { passed: true }; };
    const db = new Db(); dbs.push(db);
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    seed(db, P, repo, worktreePath, branch, "pnpm gate");

    // Dirty at the preLanded clean-shortcut's own stamp, clean again before the gate's own before-spawn
    // dirty check — so this takes the REAL gate path (not the clean ALREADY_MERGED shortcut), exactly
    // the routing a production dirty-worktree preLanded re-confirm takes.
    stageDirtClearedBeforeGateSpawns(sessions, branch, worktreePath);

    const confirm = await sessions.confirmWorkerMerge(P.mgrId, P.workerId);
    check("(A) the real gate path ran (not the clean ALREADY_MERGED shortcut)", gateCalls === 1);
    check("(A) refused via confirmWorkerMerge, not silently re-landed", confirm.merged === false && confirm.landedContentDiverged === true);
    check("(A) feature-a.txt stays ABSENT through the full confirmWorkerMerge wiring", !fs.existsSync(path.join(repo, "feature-a.txt")));
    check("(A) worktree retained for a retry (not torn down on this refusal)", fs.existsSync(worktreePath) === true);
    check("(A) [loom:merge-rejected] reads as a human decision, not a code/branch bug", /human must decide/i.test(confirm.reason ?? "") || /human must decide/i.test(confirm.detailText ?? ""));

  }

  // ── (B) NEVER-CACHED — card afa80698 round 2, item 2's own explicit ask: "add a test that
  //        landed-content-diverged is never cached". `confirmWorkerMerge` (what (A)/(C) call) is the RAW
  //        method — the until-superseded verdict cache lives entirely in `confirmWorkerMergeTracked`'s own
  //        `pendingOps.attach()` wrapper, so THIS scenario must go through that real entrypoint (the one
  //        `confirmWorkerMergeUntilSettled`/the MCP tool actually calls) to mean anything. Same shape as
  //        (A), self-contained: re-stages the dirty-then-clean race before EACH tracked call, so both
  //        calls take the identical real-gate route and the only variable under test is whether the
  //        second verdict was served from cache (`r2.cacheHit`) rather than genuinely re-derived. ───────
  {
    console.log("\n— (B) a re-confirm on the SAME op must NOT replay a cached verdict —");
    const P = mk("b");
    const repo = makeRepo("b");
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const { worktreePath, branch } = await createWorktree(repo, P.projId, P.taskId);
    worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "feature-b.txt"), "work for B\n");
    commitAll(worktreePath, "feature work", GIT_ID);

    const land = await mergeBranch(repo, branch, "feature B landed");
    check("(B) precondition: landed cleanly", land.ok === true);
    const X = headSha(repo);
    revert(repo, X);
    check("(B) precondition: the revert landed, feature-b.txt is gone again", !fs.existsSync(path.join(repo, "feature-b.txt")));

    let gateCalls = 0;
    const fakeGate = async () => { gateCalls++; return { passed: true }; };
    const db = new Db(); dbs.push(db);
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate, syncAttachBudgetMs: 60_000 });
    seed(db, P, repo, worktreePath, branch, "pnpm gate");

    stageDirtClearedBeforeGateSpawns(sessions, branch, worktreePath);
    const r1 = await settleTracked(() => sessions.confirmWorkerMergeTracked(P.mgrId, P.workerId), { label: "confirmWorkerMergeTracked op1" });
    check("(B) op 1: refused via landedContentDiverged (a genuine fresh mint)", r1.ok === true && r1.value?.merged === false && r1.value?.landedContentDiverged === true);
    check("(B) op 1 carries NO cacheHit (there was nothing to replay yet)", r1.cacheHit === undefined);
    check("(B) op 1: the real gate ran exactly once", gateCalls === 1);

    stageDirtClearedBeforeGateSpawns(sessions, branch, worktreePath);
    const r2 = await settleTracked(() => sessions.confirmWorkerMergeTracked(P.mgrId, P.workerId), { label: "confirmWorkerMergeTracked op2" });
    check("(B) op 2: refuses the SAME way (landedContentDiverged, not silently re-landed)", r2.ok === true && r2.value?.merged === false && r2.value?.landedContentDiverged === true);
    check("(B) THE NEVER-CACHED PROOF (structural): op 2 carries NO cacheHit — landed-content-diverged is excluded from the until-superseded cache", r2.cacheHit === undefined);
    check("(B) THE NEVER-CACHED PROOF (behavioral): the fake gate ran AGAIN — a genuine re-derivation, not a cache replay", gateCalls === 2);
    check("(B) feature-b.txt is still absent after the second confirm too", !fs.existsSync(path.join(repo, "feature-b.txt")));
  }

  // ── (C) NO-GATECOMMAND PROJECT — card afa80698 round 2 item 3. Identical shape to (A) EXCEPT the
  //        project has NO gateCommand configured at all, so the `if (gate)` block that normally derives
  //        `expectAlreadyLanded` never runs — the call-site derivation (`!gate && !owedBase`) must catch
  //        it instead. ─────────────────────────────────────────────────────────────────────────────────
  {
    console.log("\n— (C) the SAME shape on a NO-gateCommand project —");
    const P = mk("c");
    const repo = makeRepo("c");
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const { worktreePath, branch } = await createWorktree(repo, P.projId, P.taskId);
    worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "feature-c.txt"), "work for C\n");
    commitAll(worktreePath, "feature work", GIT_ID);

    const land = await mergeBranch(repo, branch, "feature C landed");
    check("(C) precondition: landed cleanly", land.ok === true);
    const X = headSha(repo);

    revert(repo, X);
    check("(C) precondition: the revert landed, feature-c.txt is gone again", !fs.existsSync(path.join(repo, "feature-c.txt")));

    // Dirtiness is irrelevant on the gateless path (there is no clean-shortcut stamp read at all — see
    // confirmWorkerMerge's own structure: the `if (preLanded) { ...landedStamp... }` shortcut lives
    // INSIDE `if (gate)`), kept anyway so this scenario's own construction mirrors (A) as closely as
    // possible.
    fs.writeFileSync(path.join(worktreePath, "dirt.txt"), "kept for parity with (A)\n");

    let gateCalls = 0;
    const fakeGate = async () => { gateCalls++; return { passed: true }; };
    const db = new Db(); dbs.push(db);
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    seed(db, P, repo, worktreePath, branch, undefined); // NO gateCommand configured

    const confirm = await sessions.confirmWorkerMerge(P.mgrId, P.workerId);
    check("(C) THE FIX: refused via landedContentDiverged even with NO gateCommand configured", confirm.merged === false && confirm.landedContentDiverged === true);
    check("(C) feature-c.txt stays ABSENT on the gateless path too", !fs.existsSync(path.join(repo, "feature-c.txt")));
    check("(C) zero gate calls — this project genuinely has no gate to run", gateCalls === 0);
    check("(C) worktree retained for a retry", fs.existsSync(worktreePath) === true);
  }

  // ── (D) RESIDUE-POSSIBLE DETAILTEXT — card fc7827e7 item 1. Same dirty-preLanded-then-reverted shape
  //        as (A), PLUS pre-existing UNSTAGED dirt in the CANONICAL repo (not the worktree) on a path
  //        unrelated to the branch — mirrors merge-prelanded-content-diverged.mjs's own scenario (5), now
  //        driven through the REAL confirmWorkerMerge wiring instead of calling mergeBranch directly, so
  //        it exercises `detailText` (service.ts), not just `reason` (worktrees.ts). ──────────────────────
  {
    console.log("\n— (D) confirm-level detailText: pre-existing canonical unstaged dirt sets residuePossible —");
    const P = mk("d");
    const repo = makeRepo("d");
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const { worktreePath, branch } = await createWorktree(repo, P.projId, P.taskId);
    worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "feature-d.txt"), "work for D\n");
    commitAll(worktreePath, "feature work", GIT_ID);

    const land = await mergeBranch(repo, branch, "feature D landed");
    check("(D) precondition: landed cleanly", land.ok === true);
    const X = headSha(repo);

    revert(repo, X); // lands BEFORE the re-confirm
    check("(D) precondition: the revert landed, feature-d.txt is gone again", !fs.existsSync(path.join(repo, "feature-d.txt")));

    // Pre-existing UNSTAGED dirt in the CANONICAL repo (not the worktree), on a path totally unrelated to
    // the branch — makes `hadUnstagedDirtAtEntry` true, so `resetOrSkip` SKIPS the cleanup and
    // `residuePossible` is set on the raw `mergeBranch` result this confirm wraps.
    fs.appendFileSync(path.join(repo, "README.md"), "a human's own in-progress edit\n");

    let gateCalls = 0;
    const fakeGate = async () => { gateCalls++; return { passed: true }; };
    const db = new Db(); dbs.push(db);
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    seed(db, P, repo, worktreePath, branch, "pnpm gate");

    // Dirty at the preLanded clean-shortcut's own stamp, clean again before the gate's own before-spawn
    // dirty check (see (A)'s own comment) — the CANONICAL dirt above is independent of this worktree race.
    stageDirtClearedBeforeGateSpawns(sessions, branch, worktreePath);

    const confirm = await sessions.confirmWorkerMerge(P.mgrId, P.workerId);
    check("(D) refused via confirmWorkerMerge, not silently re-landed", confirm.merged === false && confirm.landedContentDiverged === true);
    check("(D) THE ASSERTION THIS CARD ADDS: detailText names the git diff --cached remedy", /git diff --cached/.test(confirm.detailText ?? ""));
    check("(D) THE ASSERTION THIS CARD ADDS: detailText does NOT claim the canonical repo is untouched", !/untouched/i.test(confirm.detailText ?? ""));
    check("(D) the pre-existing README.md edit survives (resetOrSkip correctly declined to discard it)", fs.readFileSync(path.join(repo, "README.md"), "utf8").includes("a human's own in-progress edit"));
    check("(D) worktree retained for a retry", fs.existsSync(worktreePath) === true);
  }

  console.log(failures === 0
    ? "\n✅ ALL PASS — a real SessionService.confirmWorkerMerge call on a dirty-preLanded, reverted-before-the-gate branch refuses via landedContentDiverged (A); a re-confirm on the same op genuinely re-derives rather than replaying a cached verdict (B); the same protection reaches a project with NO gateCommand configured at all (C); and when the canonical repo's own pre-existing dirt blocks the cleanup, confirmWorkerMerge's own detailText names the residue and never claims the repo is untouched (D)."
    : `\n❌ ${failures} FAILURE(S).`);
} finally {
  for (const db of dbs) { try { db.close(); } catch { /* ignore */ } }
  for (const wt of worktrees) cleanupPathSync(wt);
}

process.exit(failures === 0 ? 0 : 1);
