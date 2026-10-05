import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card bd9a483b — the ungated-landing-check safety net: BEHAVIOUR half (CR round 2). Real git on temp
// repos + the SAME injected `runGate` seam merge-gate-interval.mjs uses (its call counter proves whether
// EITHER the real gate OR the landing-check spawned, since confirmWorkerMerge's own real-gate path and
// runUngatedLandingCheck share the identical `this.runGate` injection point).
//
//   (1) command UNSET (today's default): an interval-skipped landing is byte-identical to before this
//       card — the check never runs, the counter still advances via applyUngatedLanding.
//   (2) command SET + the check PASSES: the check runs BEFORE the repo guard (admit-worker precedes
//       acquireRepoGuardOnly in the log — asserted directly below), the landing still lands, the counter
//       still advances (never reset — this is NOT a gated pass), and its OWN distinct `worker_gate` row
//       carries `landingCheckOnly:true` with `skipReason` absent (never stamped on this row).
//   (3) command SET + the check FAILS: the landing is REFUSED (reason names "ungated landing check
//       failed"), nothing is squashed, the counter and `gateOwed` are COMPLETELY UNTOUCHED (never treated
//       as a periodic gate failure), the refusal is NEVER CACHED (a re-call after the fix lands for real),
//       and both a `merge_rejected` event and the check's own `worker_gate` row carry `landingCheckOnly:true`.
//   (4) NEGATIVE CONTROL: `mergeGate:"off"` with NO interval (cadence `never`, skipReason "gate-disabled")
//       + the command SET ⇒ the check does NOT run at all — scope is `skipReason:"gate-interval"` only.
//   (5) NO-CONFUSION: after (3)'s red, the merge-gate interval STATE (counter, gateOwed, lastPassSha) is
//       exactly what it was before the check ran — no reader of this landing's own history can derive a
//       "last gated pass"/`gateOwed`/counter fact from the check's own row; `countGateEvents` tallies it
//       under its own `"landingCheck"` bucket, never `"worker"` or `"merge"`.
//   (6) PER-REPO: mirrors gateCommand's resolution exactly — a secondary repo with NO
//       ungatedLandingCheckCommand of its own runs no check at all (even though the project-level/primary
//       value IS configured — it never inherits), while a secondary repo WITH its own command runs THAT
//       command (proven by a stub keyed per-command).
//   (7) CANCEL: a landing-check withdrawn via gate_cancel while genuinely QUEUED (cap saturated by a
//       holder) settles as `cancelled:true`, never a crash, never cached, and the tombstone settles
//       `verdict:"cancelled"`.
//   (8) gate_status(opId) resolves the landing-check's own opId AFTER it settles (the durable tombstone
//       this card mints/settles directly, bypassing PendingOpRegistry), carrying `landingCheckOnly:true`.
//
// Round 3 (card bd9a483b) adds:
//   (9a) STALE LIVELOCK, main-moves-is-NOT-stale: an unrelated commit landing on MAIN while the check runs
//        (Loom's own later re-union source) does not flag the check's own verdict as stale — the landing
//        still lands. Raw head-equality would wrongly flag this; verifyReviewedTipChain's reviewed-tip
//        walk (card bbccf470) accepts the clean merge-of-main this produces.
//   (9b) STALE LIVELOCK, worker-commit-DURING-the-check IS stale: a genuine new commit on the WORKER's own
//        branch while the check runs is correctly refused — never a fast-forward/merge of main, so the
//        walk rejects it. Never cached.
//   (10) RUNNING CANCEL: an already-ADMITTED (not merely queued) landing-check cancelled via
//        `GateSemaphore.cancelRunning` settles as `cancelled:true`, never a red, never cached — mirrors
//        (7)'s queued-cancel coverage for the OTHER cancellable phase.
//
// stop-worker-cancels-gate-before-sweep.mjs's own (J) covers the companion exclusion: a RUNNING
// landing-check is never touched by a worker stop either (isWorkerSelfCheckGate's landingCheckOnly
// exclusion), not just by its own gate_cancel.
//
// Run: 1) build daemon (pnpm build), 2) node test/ungated-landing-check.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";
const noReap = async () => ({ killedPids: [] });

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-ulc-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { GateCancelledError } = await import("../dist/orchestration/gate-semaphore.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=ulc@loom -c user.name=ulc";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });

// ============ fixtures (same template-repo-via-fs.cpSync speedup as merge-gate-interval.mjs) ============
const TEMPLATE_REPO = path.join(os.tmpdir(), `loom-ulc-tmpl-${sfx}`);
registerForCleanup(TEMPLATE_REPO);
(() => {
  mkdirp(TEMPLATE_REPO);
  fs.writeFileSync(path.join(TEMPLATE_REPO, "README.md"), "# ulc\n");
  mkdirp(path.join(TEMPLATE_REPO, "src"));
  fs.writeFileSync(path.join(TEMPLATE_REPO, "src", "baseline.ts"), "export const BASELINE = true;\n");
  execSync(`git init -q && git config user.email ulc@loom && git config user.name ulc`, { cwd: TEMPLATE_REPO });
  commitAll(TEMPLATE_REPO, "init", GIT_ID);
})();
function makeRepo(repo) {
  mkdirp(path.dirname(repo));
  registerForCleanup(repo);
  fs.cpSync(TEMPLATE_REPO, repo, { recursive: true });
}
const mk = (label) => ({
  projId: `ulc-${label}-proj-${sfx}`, agentId: `ulc-${label}-agent-${sfx}`, mgrId: `ulc-${label}-mgr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-ulc-${label}-${sfx}`),
});
async function seedProject(db, P, orchestration) {
  db.insertProject({ id: P.projId, name: "ULC", repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: "pnpm gate", ...orchestration } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
}
async function addWorker(db, P, n, files, repoPath = P.repo, repoKey = null) {
  const taskId = `ulc-${n}-task-${sfx}`;
  const workerId = `ulc-${n}-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: P.projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now, ...(repoKey ? { repoKey } : {}) });
  const { worktreePath, branch } = await createWorktree(repoPath, P.projId, taskId, {}, repoKey);
  worktrees.push(worktreePath);
  for (const [rel, body] of Object.entries(files)) { mkdirp(path.dirname(path.join(worktreePath, rel))); fs.writeFileSync(path.join(worktreePath, rel), body); }
  commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
  db.insertSession({ id: workerId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId, worktreePath, branch, ...(repoKey ? { repoKey } : {}) });
  return { taskId, workerId, worktreePath, branch };
}
/** Same shape as merge-gate-interval(-ordering).mjs's own mkService — a service whose injected gate honours
 *  `gate.pass` and counts calls. This ONE seam backs BOTH the real gateCommand path (never reached in these
 *  interval-skip scenarios) and runUngatedLandingCheck's own `this.runGate` — so `gate.calls` proves whether
 *  EITHER ran, and the scope assertions below (gate.calls === 0 in (1)/(4)) are a real negative control.
 *  `gate.lastCommand` records what was actually run (scenario (6) keys a per-command stub off it). */
function mkService(db) {
  const gate = { calls: 0, pass: true, lastCommand: null, commands: [] };
  const sessions = new SessionService(db, { stop() {}, isAlive() { return false; }, enqueueStdin() {} }, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000,
    runGate: async (command) => {
      gate.calls++;
      gate.lastCommand = command;
      gate.commands.push(command);
      return gate.pass ? { passed: true, steps: [] } : { passed: false, failedStep: "test", failedStatus: 1, steps: [] };
    },
    reapWorktreeProcesses: noReap,
  });
  return { sessions, gate };
}
const confirm = async (sessions, mgrId, workerId) => {
  const r = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  return r.settled && r.ok ? r.value : { __unsettled: r };
};
const landingCheckRows = (db, mgrId) => db.listEvents(mgrId).filter((e) => e.kind === "worker_gate" && e.detail?.landingCheckOnly === true);

const dbs = [];
const worktrees = [];
try {
  // ── (1) command UNSET: byte-identical to before this card ─────────────────────────────────────────
  {
    const P = mk("u1"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 3 }); // ungatedLandingCheckCommand left unset
    const w = await addWorker(db, P, "u1a", { "src/u1a.ts": "export const u1a = 1;\n" });
    const v = await confirm(ctx.sessions, P.mgrId, w.workerId);
    check("(1) unset command: the landing lands ungated exactly as before", v.merged === true && v.skipReason === "gate-interval");
    check("(1) unset command: NOTHING spawned through the gate seam (the check never ran)", ctx.gate.calls === 0);
    check("(1) unset command: the counter still advances via applyUngatedLanding", db.getMergeGateState(P.projId).ungatedSinceLastPass === 1);
    check("(1) unset command: no landingCheckOnly row was ever written", landingCheckRows(db, P.mgrId).length === 0);
  }

  // ── (2) command SET + PASSES: runs BEFORE the repo guard, lands, counter still advances ────────────
  {
    const P = mk("u2"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 3, ungatedLandingCheckCommand: "pnpm guards" });
    const w = await addWorker(db, P, "u2a", { "src/u2a.ts": "export const u2a = 1;\n" });
    // RESTRUCTURE WITNESS (CR round 2, ruling 1): the check is admitted (gateType:"worker") BEFORE the
    // repo guard (acquireRepoGuardOnly) is ever taken — assert via the live semaphore log shape: at the
    // instant the check is queued/running, NOTHING is yet held in the repo-guard-only registry for this repo.
    let guardHeldWhileChecking = null;
    const origAcq = ctx.sessions.gateSemaphore.acquireRepoGuardOnly.bind(ctx.sessions.gateSemaphore);
    ctx.sessions.gateSemaphore.acquireRepoGuardOnly = async (...a) => { guardHeldWhileChecking ??= ctx.gate.calls > 0; return origAcq(...a); };
    const v = await confirm(ctx.sessions, P.mgrId, w.workerId);
    check("(2) RESTRUCTURE: the repo guard was first acquired AFTER the landing-check already ran (no repo lock held while it queued/ran)", guardHeldWhileChecking === true);
    check("(2) command set + passes: the landing still lands ungated", v.merged === true && v.skipReason === "gate-interval");
    check("(2) command set + passes: the check actually ran through the shared gate seam", ctx.gate.calls === 1);
    check("(2) command set + passes: the counter advances (applyUngatedLanding) — NEVER a gated pass (lastPassSha stays null)", db.getMergeGateState(P.projId).ungatedSinceLastPass === 1 && db.getMergeGateState(P.projId).lastPassSha === null);
    const rows = landingCheckRows(db, P.mgrId);
    check("(2) command set + passes: its OWN distinct worker_gate row exists, landingCheckOnly:true, passed:true", rows.length === 1 && rows[0].detail.passed === true && typeof rows[0].detail.opId === "string");
    check("(2) READERS: skipReason is absent on this row (it names why a MERGE's gate was skipped — this isn't a merge row)", rows[0].detail.skipReason === undefined);
    check("(2) command set + passes: the file actually landed on main", fs.existsSync(path.join(P.repo, "src", "u2a.ts")));
  }

  // ── (3) command SET + FAILS: refused, nothing squashed, counter/gateOwed UNTOUCHED, never cached ───
  {
    const P = mk("u3"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 3, ungatedLandingCheckCommand: "pnpm guards" });
    db.putMergeGateState(P.projId, { ...db.getMergeGateState(P.projId), ungatedSinceLastPass: 1 });
    const stateBefore = JSON.stringify(db.getMergeGateState(P.projId));
    const w = await addWorker(db, P, "u3a", { "src/u3a.ts": "export const u3a = 1;\n" });
    ctx.gate.pass = false;
    const v = await confirm(ctx.sessions, P.mgrId, w.workerId);
    check("(3) command set + fails: the landing is REFUSED, naming the check (never a bare 'build gate failed')", v.merged === false && /ungated landing check failed/.test(v.reason ?? "") && v.ungatedLandingCheckFailed === true);
    check("(3) command set + fails: nothing was squashed (the file never landed, worktree retained)", !fs.existsSync(path.join(P.repo, "src", "u3a.ts")) && fs.existsSync(w.worktreePath));
    check("(3) command set + fails: the merge-gate state is COMPLETELY UNTOUCHED (counter, gateOwed, lastPassSha, ring) — not treated as a periodic gate failure", JSON.stringify(db.getMergeGateState(P.projId)) === stateBefore);
    const rows = landingCheckRows(db, P.mgrId);
    check("(3) command set + fails: its OWN distinct worker_gate row exists, landingCheckOnly:true, passed:false", rows.length === 1 && rows[0].detail.passed === false);
    const rejected = db.listEvents(P.mgrId).filter((e) => e.kind === "merge_rejected" && e.detail?.reason === "ungated_landing_check_failed");
    check("(3) command set + fails: a merge_rejected event names the reason + carries landingCheckOnly:true", rejected.length === 1 && rejected[0].detail.landingCheckOnly === true);
    // NEVER CACHED: fix the check and re-confirm the SAME worker at the SAME commit — it must genuinely re-run, not replay the stale red.
    ctx.gate.pass = true;
    const v2 = await confirm(ctx.sessions, P.mgrId, w.workerId);
    check("(3) NEVER CACHED: after the fix, a re-confirm at the SAME commit genuinely re-runs (lands for real, not a replayed refusal)", v2.merged === true && v2.cacheHit === undefined && fs.existsSync(path.join(P.repo, "src", "u3a.ts")));
    check("(3) the re-confirm's own successful landing now advances the counter (1 -> 2)", db.getMergeGateState(P.projId).ungatedSinceLastPass === 2);
  }

  // ── (4) NEGATIVE CONTROL: gate-disabled (no interval) + command SET ⇒ the check must NOT run ───────
  {
    const P = mk("u4"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", ungatedLandingCheckCommand: "pnpm guards" }); // NO mergeGateInterval ⇒ cadence "never" ⇒ skipReason "gate-disabled"
    const w = await addWorker(db, P, "u4a", { "src/u4a.ts": "export const u4a = 1;\n" });
    ctx.gate.pass = false; // if the check ran at all under gate-disabled, this would wrongly refuse the landing
    const v = await confirm(ctx.sessions, P.mgrId, w.workerId);
    check("(4) NEGATIVE CONTROL: a gate-disabled (no interval) landing still lands even with the check configured AND set to fail", v.merged === true && v.skipReason === "gate-disabled");
    check("(4) NEGATIVE CONTROL: the check never ran (scope is skipReason gate-interval only, never gate-disabled)", ctx.gate.calls === 0);
    check("(4) NEGATIVE CONTROL: no landingCheckOnly row was ever written", landingCheckRows(db, P.mgrId).length === 0);
  }

  // ── (5) NO-CONFUSION: a landing-check row can never be read as a real gated pass/fail ──────────────
  {
    const P = mk("u5"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2, ungatedLandingCheckCommand: "pnpm guards" });
    const w1 = await addWorker(db, P, "u5a", { "src/u5a.ts": "export const u5a = 1;\n" });
    const v1 = await confirm(ctx.sessions, P.mgrId, w1.workerId);
    check("(5) setup: a passing landing-check row exists alongside the ordinary ungated landing", v1.merged === true && landingCheckRows(db, P.mgrId).length === 1);
    // The ONLY way this project's merge-gate state ever reads a "pass" (lastPassSha set / counter reset /
    // a `recent` ring row with result:"pass") is via applyGatePass — never via runUngatedLandingCheck, which
    // calls neither applyGatePass nor applyGateFail nor recordMergeGateFailure. Assert the LIVE state agrees.
    const s = db.getMergeGateState(P.projId);
    check("(5) NO CONFUSION: despite a PASSING landingCheckOnly row existing, lastPassSha is still null (no gated pass was ever recorded)", s.lastPassSha === null);
    check("(5) NO CONFUSION: the ring (`recent`) carries NO row at all from the landing-check — it is a SEPARATE event kind (worker_gate), never folded into this state's own ring", s.recent.length === 0);
    check("(5) NO CONFUSION: decideMergeGateFor for the NEXT landing still reads the ordinary ungated counter (1), unaffected by the landing-check row's own existence", ctx.sessions.decideMergeGateFor(P.projId, 1).gate === false);
    // This landing ALSO carries the PRE-EXISTING "build_gate" skip-record every gate-interval landing has
    // always recorded (skipped:true, skipReason:"gate-interval", gateType "merge") — that one correctly
    // tallies as "merge" (it genuinely IS the landing's own merge-skip audit row, unrelated to the check).
    // The actual no-confusion property: the landing-check's OWN row never gets FOLDED into that same
    // "merge" bucket (or into "worker") — it stays in its own, separately-countable "landingCheck" bucket.
    const counts = db.countGateEvents({ projectId: P.projId });
    check("(5) READERS: countGateEvents tallies the landing-check row under its OWN \"landingCheck\" bucket (not folded into \"merge\"'s pre-existing skip-record tally, and never \"worker\")", counts.byGateType.landingCheck === 1 && counts.byGateType.merge === 1 && !counts.byGateType.worker);
  }

  // ── (6) PER-REPO: mirrors gateCommand's resolution exactly ─────────────────────────────────────────
  {
    const P = mk("u6"); makeRepo(P.repo);
    const repo2NoCheck = path.join(os.tmpdir(), `loom-ulc-u6-r2a-${sfx}`); makeRepo(repo2NoCheck);
    const repo2WithCheck = path.join(os.tmpdir(), `loom-ulc-u6-r2b-${sfx}`); makeRepo(repo2WithCheck);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    // Primary HAS the project-level command configured; both secondary repos have their OWN gateCommand,
    // and only "r2b" carries its OWN ungatedLandingCheckCommand — "r2a" deliberately has none, to prove it
    // never inherits the primary's.
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 3, ungatedLandingCheckCommand: "pnpm guards-primary" });
    db.updateProject(P.projId, { repos: [
      { key: "r2a", path: repo2NoCheck, gateCommand: "pnpm gate-r2a" },
      { key: "r2b", path: repo2WithCheck, gateCommand: "pnpm gate-r2b", ungatedLandingCheckCommand: "pnpm guards-r2b" },
    ] });
    const wa = await addWorker(db, P, "u6a", { "src/u6a.ts": "export const u6a = 1;\n" }, repo2NoCheck, "r2a");
    const va = await confirm(ctx.sessions, P.mgrId, wa.workerId);
    check("(6a) a secondary repo with NO ungatedLandingCheckCommand of its own runs NO check at all (never inherits the primary's)", va.merged === true && va.skipReason === "gate-interval" && ctx.gate.calls === 0);
    check("(6a) no landingCheckOnly row was ever written for r2a", landingCheckRows(db, P.mgrId).length === 0);
    const wb = await addWorker(db, P, "u6b", { "src/u6b.ts": "export const u6b = 1;\n" }, repo2WithCheck, "r2b");
    const vb = await confirm(ctx.sessions, P.mgrId, wb.workerId);
    check("(6b) a secondary repo WITH its own ungatedLandingCheckCommand runs ITS OWN command (never the primary's)", vb.merged === true && ctx.gate.calls === 1 && ctx.gate.lastCommand === "pnpm guards-r2b");
    check("(6b) the primary's own command was never invoked for r2b's landing", !ctx.gate.commands.includes("pnpm guards-primary"));
  }

  // ── (7) CANCEL: a queued landing-check withdrawn via gate_cancel settles cleanly, never cached ──────
  {
    const P = mk("u7"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    db.setPlatformConfig({ maxConcurrentGates: 1 }); // saturate the SHARED cap at 1 so the check below genuinely queues
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 3, ungatedLandingCheckCommand: "pnpm guards" });
    const w = await addWorker(db, P, "u7a", { "src/u7a.ts": "export const u7a = 1;\n" });
    let releaseHolder;
    const holderPromise = new Promise((res) => { releaseHolder = res; });
    const holderP = ctx.sessions.gateSemaphore.runExclusive(1, { gateType: "worker", projectId: P.projId, sessionId: "u7-holder", worktreePath: "/tmp/u7-holder-wt" }, async () => { await holderPromise; return "holder"; });
    await waitUntil(() => ctx.sessions.gateSemaphore.snapshot().active === 1, { timeoutMs: 30000, intervalMs: 20, label: "ungated-landing-check (7): the holder is admitted" });
    const confirmP = confirm(ctx.sessions, P.mgrId, w.workerId);
    const queuedEntry = await waitUntil(() => ctx.sessions.gateSemaphore.snapshot().entries.find((e) => e.sessionId === w.workerId && e.gateType === "worker" && e.phase === "queued"), { timeoutMs: 30000, intervalMs: 20, label: "ungated-landing-check (7): the landing-check is genuinely QUEUED" });
    check("(7) precondition: the landing-check never spawned while queued (zero process risk)", ctx.gate.calls === 0);
    // Card bd9a483b (CR round 3): cancel by EXACT entry id (`cancelQueued`), mirroring the real manager
    // gate_cancel tool's own queued-phase branch (`cancelGateOp`, resolved via `findByOpId`) — never the
    // coarser session-scoped `cancelQueuedForSession`, which now deliberately excludes landingCheckOnly
    // entries (that primitive is reserved for the auto-supersede path, which must never catch one).
    const cancelled = ctx.sessions.gateSemaphore.cancelQueued(queuedEntry.id, "manual", "test cancel");
    check("(7) a manager's gate_cancel (by exact id) finds and cancels the queued landing-check", cancelled === true);
    releaseHolder();
    const holderResult = await holderP;
    check("(7) the holder still completes normally", holderResult === "holder");
    const v = await confirmP;
    check("(7) the cancelled landing-check settles CLEANLY as cancelled:true — never a crash, never a refusal", v.merged === false && v.cancelled === true && v.cancelKind === "manual");
    check("(7) the check's own fn was NEVER invoked (zero process risk, mirrors the real gate's own cancel-while-queued path)", ctx.gate.calls === 0);
    check("(7) NEVER CACHED / NEVER COUNTED: the merge-gate counter/gateOwed are untouched by a cancelled check", db.getMergeGateState(P.projId).ungatedSinceLastPass === 0 && db.getMergeGateState(P.projId).gateOwed === false);
    const cancelledRows = db.listEvents(P.mgrId).filter((e) => e.kind === "worker_gate" && e.detail?.landingCheckOnly === true && e.detail?.cancelled === true);
    check("(7) a worker_gate event records the cancellation, landingCheckOnly:true", cancelledRows.length === 1 && cancelledRows[0].detail.cancelKind === "manual");
    // (8) gate_status(opId) resolves the SETTLED landing-check tombstone this card mints/settles directly.
    const opId = cancelledRows[0].detail.opId;
    const status = ctx.sessions.gateStatus(opId);
    check("(8) gate_status(opId) resolves the settled landing-check tombstone (bypassing PendingOpRegistry)", status.state === "settled" && status.landingCheckOnly === true && status.cancelled === true);
  }

  // ── (9a) STALE LIVELOCK: main moving DURING the check (Loom's OWN re-union) is NOT staleness ──────────
  {
    const P = mk("u9a"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 3, ungatedLandingCheckCommand: "pnpm guards" });
    const w = await addWorker(db, P, "u9a", { "src/u9a.ts": "export const u9a = 1;\n" });
    // Land an UNRELATED commit directly on main WHILE the check is "running" — exactly the kind of
    // Loom-caused movement (its own later re-union of main into the worktree) the stale re-check must
    // tolerate, never flag as a worker commit.
    ctx.sessions.runGate = async (command) => {
      ctx.gate.calls++; ctx.gate.lastCommand = command; ctx.gate.commands.push(command);
      fs.writeFileSync(path.join(P.repo, "src", "mainmove-u9a.ts"), "export const mainMoveU9a = 1;\n");
      commitAll(P.repo, "chore: unrelated main advance during the u9a landing check", GIT_ID);
      return { passed: true, steps: [] };
    };
    const v = await confirm(ctx.sessions, P.mgrId, w.workerId);
    check("(9a) STALE LIVELOCK: main moving during the check is NOT staleness — the landing still lands", v.merged === true && v.skipReason === "gate-interval");
    check("(9a) the worker's own file landed", fs.existsSync(path.join(P.repo, "src", "u9a.ts")));
    check("(9a) the unrelated main-advance commit (Loom's own re-union source) is still present on main, never clobbered", fs.existsSync(path.join(P.repo, "src", "mainmove-u9a.ts")));
  }

  // ── (9b) STALE LIVELOCK: a genuine WORKER commit DURING the check IS staleness — refused ──────────────
  {
    const P = mk("u9b"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 3, ungatedLandingCheckCommand: "pnpm guards" });
    const w = await addWorker(db, P, "u9b", { "src/u9b.ts": "export const u9b = 1;\n" });
    ctx.sessions.runGate = async (command) => {
      ctx.gate.calls++; ctx.gate.lastCommand = command; ctx.gate.commands.push(command);
      // The worker keeps typing WHILE the check runs: a genuine new commit on its OWN worktree branch,
      // never a merge of main — verifyReviewedTipChain must reject this (not a fast-forward through main,
      // not a clean merge of main).
      fs.writeFileSync(path.join(w.worktreePath, "src", "u9b-more.ts"), "export const u9bMore = 1;\n");
      commitAll(w.worktreePath, "feat(x): u9b keeps typing during its own landing check", GIT_ID);
      return { passed: true, steps: [] };
    };
    const v = await confirm(ctx.sessions, P.mgrId, w.workerId);
    check("(9b) STALE LIVELOCK: a genuine worker commit during the check IS staleness — the landing is refused", v.merged === false && /changed with a new commit/.test(v.reason ?? "") && v.ungatedLandingCheckFailed === true);
    check("(9b) nothing was squashed (never cached: a re-confirm genuinely re-checks, not replayed here)", !fs.existsSync(path.join(P.repo, "src", "u9b.ts")) && fs.existsSync(w.worktreePath));
    const rejected = db.listEvents(P.mgrId).filter((e) => e.kind === "merge_rejected" && e.detail?.reason === "ungated_landing_check_stale");
    check("(9b) a merge_rejected event names the stale reason + carries landingCheckOnly:true", rejected.length === 1 && rejected[0].detail.landingCheckOnly === true);
  }

  // ── (10) RUNNING CANCEL: an ADMITTED (running) landing-check cancelled via cancelRunning settles cleanly,
  // never a red, never cached ────────────────────────────────────────────────────────────────────────────
  {
    const P = mk("u10"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 3, ungatedLandingCheckCommand: "pnpm guards" });
    const w = await addWorker(db, P, "u10a", { "src/u10a.ts": "export const u10a = 1;\n" });
    // Mirrors stop-worker-cancels-gate-before-sweep.mjs's own makeRespondingGate: resolves with a real
    // GateSequentialResult `{cancelled:true}` shape the instant the abort signal fires — the same shape
    // the REAL runGateSequential produces when its own child process is killed via the signal.
    let aborted = false;
    ctx.sessions.runGate = (command, _cwd, _timeoutMs, _runStep, _env, _spawned, cancelSignal) => {
      ctx.gate.calls++; ctx.gate.lastCommand = command;
      return new Promise((resolve) => {
        const onAbort = () => { aborted = true; resolve({ cancelled: true, passed: false, steps: [] }); };
        if (cancelSignal?.aborted) { onAbort(); return; }
        cancelSignal?.addEventListener("abort", onAbort);
      });
    };
    const confirmP = confirm(ctx.sessions, P.mgrId, w.workerId);
    const runningEntry = await waitUntil(() => ctx.sessions.gateSemaphore.snapshot().entries.find((e) => e.sessionId === w.workerId && e.gateType === "worker" && e.phase === "running"),
      { timeoutMs: 30000, intervalMs: 20, label: "ungated-landing-check (10): the landing-check is genuinely RUNNING (admitted)" });
    check("(10) precondition: the landing-check is genuinely ADMITTED/running, carrying landingCheckOnly:true", !!runningEntry && runningEntry.landingCheckOnly === true);
    const abortedNow = ctx.sessions.gateSemaphore.cancelRunning(runningEntry.id, "test cancel (running)");
    check("(10) cancelRunning aborts the admitted landing-check", abortedNow === true);
    const v = await confirmP;
    check("(10) RUNNING CANCEL: settles as cancelled, NEVER a red", v.merged === false && v.cancelled === true && v.cancelKind === "manual");
    check("(10) the gate fn's own cancelSignal was genuinely aborted", aborted === true);
    // CR round 4 nit: the RUNNING-cancel reason is now THREADED from cancelSignalRef (mirroring the
    // real-gate path), never the hardcoded "cancelled while running" fallback, when cancelRunning's own
    // detail string is informative — proven here against the real detail passed to cancelRunning above.
    check("(10) ABORT-REASON THREADING: the settled reason carries cancelRunning's OWN detail string, not the generic fallback", v.reason === "test cancel (running)");
    check("(10) NEVER CACHED / NEVER COUNTED: the merge-gate counter/gateOwed are untouched by a cancelled check", db.getMergeGateState(P.projId).ungatedSinceLastPass === 0 && db.getMergeGateState(P.projId).gateOwed === false);
    const cancelledRows = db.listEvents(P.mgrId).filter((e) => e.kind === "worker_gate" && e.detail?.landingCheckOnly === true && e.detail?.cancelled === true);
    check("(10) a worker_gate event records the RUNNING cancellation, landingCheckOnly:true", cancelledRows.length === 1 && cancelledRows[0].detail.cancelKind === "manual");
    const status = ctx.sessions.gateStatus(cancelledRows[0].detail.opId);
    check("(10) gate_status(opId) resolves the settled RUNNING-cancel tombstone", status.state === "settled" && status.landingCheckOnly === true && status.cancelled === true);
  }

  // ── (11) HELD BRANCH + main moving during the check (CR round 4, Major; refuted + corrected round 5):
  // a SANITY/regression check that a held branch's own re-union of main during the landing check still
  // lands correctly, paired with a WIRING check (below, via a spy) that the in-lock stale re-check routes
  // its owed-base through the SAME `extraUnionBasesForOwedBase` helper `reviewedTipVerdict` already used —
  // an anti-drift fix, not a livelock fix; full reasoning (why "RED on 1b2e544a" doesn't reproduce at the
  // content level here, and what WOULD make the owed base load-bearing) lives in
  // `docs/decisions/bd9a483b-stale-landing-check-reverification-accepts-looms-own-reunion.md`.
  {
    const repo = path.join(os.tmpdir(), `loom-ulc-u11-${sfx}`);
    mkdirp(repo);
    registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# ulc11\n");
    execSync(`git init -q && git config user.email ulc11@loom && git config user.name ulc11`, { cwd: repo });
    commitAll(repo, "init", GIT_ID);
    const projId = `ulc-u11-proj-${sfx}`, agentId = `ulc-u11-agent-${sfx}`, mgrId = `ulc-u11-mgr-${sfx}`;
    const cutHeld = async (label, files) => {
      const taskId = `ulc-u11-task-${label}-${sfx}`;
      const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
      worktrees.push(worktreePath);
      for (const f of files) fs.writeFileSync(path.join(worktreePath, f), `work ${label} ${f}\n`);
      commitAll(worktreePath, label, GIT_ID);
      return { taskId, branch, worktreePath };
    };
    const a = await cutHeld("u11a", ["feature-u11a.txt", "extra-u11a.txt"]);
    const b = await cutHeld("u11b", ["feature-u11b.txt"]);
    // Gate script that reverts extra-u11a.txt on A's branch mid-gate, so the real merge_batch below RETAINS it
    // (same fixture shape as batch-merge-late-range-landing.mjs's own setup).
    const script = path.join(os.tmpdir(), `loom-ulc-u11-gate-${sfx}.mjs`);
    registerForCleanup(script);
    fs.writeFileSync(script, [
      `import fs from "node:fs"; import path from "node:path"; import { execSync } from "node:child_process";`,
      `const wt = ${JSON.stringify(a.worktreePath)};`,
      `if (fs.existsSync(path.join(wt, "extra-u11a.txt"))) {`,
      `  execSync("git rm -q extra-u11a.txt && git -c user.email=ulc11@loom -c user.name=ulc11 commit -q -m late-revert", { cwd: wt, stdio: "ignore" });`,
      `}`,
      `process.exit(0);`,
    ].join("\n"));
    const db = new Db(); dbs.push(db);
    db.insertProject({ id: projId, name: "ULC11", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: `node "${script}"` } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const wA = `ulc-u11-wkr-a-${sfx}`, wB = `ulc-u11-wkr-b-${sfx}`;
    for (const [wId, w, label] of [[wA, a, "u11a"], [wB, b, "u11b"]]) {
      db.insertTask({ id: w.taskId, projectId: projId, title: `feat(x): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      db.insertSession({ id: wId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch });
    }
    const ptyStubU11 = { stop() {}, isAlive() { return false; }, enqueueStdin() {}, purgeQueuedWorkerReportNudgesOnMerge() {}, purgeQueuedWorkerIdleNudges() {} };
    const mkU11 = (extra = {}) => new SessionService(db, ptyStubU11, new OrchestrationControl(), { syncAttachBudgetMs: 600_000, reapWorktreeProcesses: noReap, ...extra });
    const first = await mkU11().mergeBatchTracked(mgrId, [wA, wB]);
    const val = first.settled && first.ok ? first.value : undefined;
    check("(11 setup) the batch landed A and B, and A was RETAINED (held branch)", val?.ok === true && !!val.landed.find((l) => l.branch === a.branch)?.branchAdvancedDuringGate && !!val.landed.find((l) => l.branch === b.branch));

    // Switch the project to interval-ungated mode WITH a configured landing check — the SAME injected
    // runGate seam the real gate would have used.
    const cfg = db.getProject(projId).config;
    db.setProjectConfig(projId, { ...cfg, orchestration: { ...(cfg.orchestration ?? {}), mergeGate: "off", mergeGateInterval: 3, ungatedLandingCheckCommand: "pnpm guards" } });

    let movedMain = false;
    const movingLandingCheck = async () => {
      movedMain = true;
      fs.writeFileSync(path.join(repo, "mainmove-u11.txt"), "unrelated main advance during u11's held-branch landing check\n");
      commitAll(repo, "chore: unrelated main advance during u11's held-branch landing check", GIT_ID);
      return { passed: true, steps: [] };
    };
    const svc11 = mkU11({ runGate: movingLandingCheck });
    // WIRING SPY (the actual round-4 fix): record every owedBase the stale re-check's helper is called
    // with — proves the in-lock stale re-check derives its extraUnionBases from the SAME source (the
    // branch's real owedBase), never a hand-rolled/omitted one, closing the exact asymmetry CR round 4 found.
    const retainEv = db.listEventsForWorker(wA).find((e) => e.kind === "batch_merge_branch_retained");
    const expectedOwedBase = retainEv?.detail?.assembledTip;
    check("(11) setup: the retain event records a readable assembledTip to compare the spy against", typeof expectedOwedBase === "string" && expectedOwedBase.length > 0);
    const helperCalls = [];
    const origHelper = svc11.extraUnionBasesForOwedBase.bind(svc11);
    svc11.extraUnionBasesForOwedBase = (owedBase) => { helperCalls.push(owedBase); return origHelper(owedBase); };
    const v = await confirm(svc11, mgrId, wA);
    check("(11) precondition: the landing check actually ran and moved main", movedMain === true);
    check("(11) WIRING: the stale re-check routed through extraUnionBasesForOwedBase with the branch's real owedBase (never omitted, never a different value)", helperCalls.length >= 1 && helperCalls.includes(expectedOwedBase));
    check("(11) HELD BRANCH STALE LIVELOCK: a HELD branch's own re-union of main during the check is NOT staleness — the landing still lands", v.merged === true && v.skipReason === "gate-interval");
    check("(11) OUTCOME: main ends up WITHOUT the reverted extra-u11a.txt (and still WITH feature-u11a.txt)", !fs.existsSync(path.join(repo, "extra-u11a.txt")) && fs.existsSync(path.join(repo, "feature-u11a.txt")));
    check("(11) the unrelated main-advance commit (the check's own re-union source) is still present on main, never clobbered", fs.existsSync(path.join(repo, "mainmove-u11.txt")));
  }

  // ── (12) cancelQueuedForSession / supersedeQueuedSelfCheck skips a QUEUED landingCheckOnly entry (CR round 4) ──
  {
    const P = mk("u12"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    db.setPlatformConfig({ maxConcurrentGates: 1 }); // saturate the SHARED cap at 1 so both entries below genuinely queue
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 3, ungatedLandingCheckCommand: "pnpm guards" });
    const w = await addWorker(db, P, "u12a", { "src/u12a.ts": "export const u12a = 1;\n" });
    let releaseHolder;
    const holderPromise = new Promise((res) => { releaseHolder = res; });
    const holderP = ctx.sessions.gateSemaphore.runExclusive(1, { gateType: "worker", projectId: P.projId, sessionId: "u12-holder", worktreePath: "/tmp/u12-holder-wt" }, async () => { await holderPromise; return "holder"; });
    await waitUntil(() => ctx.sessions.gateSemaphore.snapshot().active === 1, { timeoutMs: 30000, intervalMs: 20, label: "ungated-landing-check (12): the holder is admitted" });
    // Two QUEUED entries for the SAME session/gateType/projectId — one an ordinary worker self-check, one
    // the worker's OWN in-flight landing-check — the exact coarse-match collision cancelQueuedForSession's
    // own doc warns about.
    const selfCheckP = ctx.sessions.gateSemaphore.runExclusive(1, { gateType: "worker", projectId: P.projId, sessionId: w.workerId, worktreePath: w.worktreePath }, async () => "selfcheck").catch((e) => e);
    const landingCheckP = ctx.sessions.gateSemaphore.runExclusive(1, { gateType: "worker", projectId: P.projId, sessionId: w.workerId, worktreePath: w.worktreePath, landingCheckOnly: true }, async () => "landingcheck").catch((e) => e);
    await waitUntil(() => ctx.sessions.gateSemaphore.snapshot().entries.filter((e) => e.sessionId === w.workerId && e.phase === "queued").length === 2,
      { timeoutMs: 30000, intervalMs: 20, label: "ungated-landing-check (12): both the self-check and the landing-check are genuinely QUEUED" });
    const landingEntryBefore = ctx.sessions.gateSemaphore.snapshot().entries.find((e) => e.sessionId === w.workerId && e.landingCheckOnly === true);
    check("(12) precondition: the landing-check entry is queued and carries landingCheckOnly:true", !!landingEntryBefore && landingEntryBefore.phase === "queued");
    const superseded = ctx.sessions.gateSemaphore.cancelQueuedForSession(w.workerId, "worker", P.projId, "manual", "test supersede");
    check("(12) cancelQueuedForSession finds and cancels the ordinary self-check (never the landing-check)", superseded.cancelled === true && superseded.opId !== landingEntryBefore.opId);
    const stillQueued = ctx.sessions.gateSemaphore.snapshot().entries.find((e) => e.id === landingEntryBefore.id);
    check("(12) the landing-check entry is STILL queued, completely untouched by the supersede", !!stillQueued && stillQueued.phase === "queued");
    releaseHolder();
    await holderP;
    const selfCheckResult = await selfCheckP;
    check("(12) the superseded self-check settles as a real GateCancelledError(\"manual\") cancellation, never a crash or some other shape", selfCheckResult instanceof GateCancelledError && selfCheckResult.kind === "manual");
    const landingCheckResult = await landingCheckP;
    check("(12) the untouched landing-check still runs through to completion", landingCheckResult === "landingcheck");
  }

  // ── (13) UNEXPECTED THROW (CR round 4, ruling-5 finally): an uncaught throw from runExclusive/runGateSeq
  // still leaves gate_status(opId) resolvable as a settled "error", never stuck pending forever ────────────
  {
    const P = mk("u13"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 3, ungatedLandingCheckCommand: "pnpm guards" });
    const w = await addWorker(db, P, "u13a", { "src/u13a.ts": "export const u13a = 1;\n" });
    ctx.sessions.runGate = async () => { throw new Error("boom: landing-check runner crashed unexpectedly"); };
    const v = await confirm(ctx.sessions, P.mgrId, w.workerId);
    check("(13) the unexpected throw surfaces as a settled, non-merged outcome (never a hang)", v.__unsettled?.settled === true && v.__unsettled?.ok === false);
    const row = db.listPendingGateOps().find((r) => r.key === `landing-check:${w.workerId}`);
    check("(13) the landing-check's own tombstone row was minted", !!row);
    const status = row ? ctx.sessions.gateStatus(row.opId) : undefined;
    check("(13) gate_status(opId) resolves the settled tombstone as outcome:error (ruling-5 finally), never stuck pending", status?.state === "settled" && status?.outcome === "error" && status?.landingCheckOnly === true);
    // Round 5 nit: the ruling-5 `finally` settle is still a BEST-EFFORT backstop, but it now captures the
    // caught error's first line into the SAME `reason` field a cancelled/fail verdict already uses — cheap
    // (one `.split("\n")[0]`, no stack, no full message), never a substitute for a real gate diagnostic.
    check("(13) the ruling-5 finally settle carries the thrown error's first line as `reason` (cheap, not a full diagnostic)", status?.reason === "boom: landing-check runner crashed unexpectedly");
  }
} finally {
  for (const d of dbs) { try { d.close(); } catch { /* ignore */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — orchestration.ungatedLandingCheckCommand runs BEFORE the repo guard (no repo lock held while it queues/runs), resolves per-repo exactly like gateCommand (never inheriting the primary's value), runs only on a genuinely interval-skipped landing (never gate-disabled), never counts as a gated pass/fail (counter + gateOwed + the ring stay untouched either way), refuses on red without caching the refusal, settles a queued OR running gate_cancel cleanly as cancelled:true (never a red, never cached), correctly tells Loom's own re-union of a moved main apart from a genuine new worker commit when re-verifying its own basis in-lock (only the latter is staleness), and is recorded on its own distinct, self-identifying worker_gate row (skipReason absent, tallied under its own countGateEvents bucket) that gate_status(opId) can resolve after settle."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
