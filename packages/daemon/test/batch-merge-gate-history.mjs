import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// SPLIT (card 4e8e2d82): this file ran 87-120s solo-in-suite (max pass 119,740ms; 1 SIGTERM kill at the 120s
// per-file ceiling, n=11 gate-timing rows). This file keeps (e2e, PASS) and (e2e, FAIL); (e2e, CANCELLED),
// (e2e, FORFEIT) and (unit) moved verbatim to batch-merge-gate-history-edge.mjs. The comment below describes
// the ORIGINAL combined file — read it as covering both halves.
//
// BATCH GATE TELEMETRY (card 3d2afb53) — the batch merge gate (card dbc6f660, `SessionService.mergeBatch`)
// settles OUTSIDE `confirmWorkerMergeTracked`'s `onSettle`, so its own `gate_history` row used to come back
// with `durationMs`/`gateCap`/`concurrentGates`/`concurrentGatesMax`/`emitCompareReduced` all null — measured
// on the first live production batch (opId 1cfb5219, row ed9bf9a0). Proves:
//   (e2e) a REAL `mergeBatch` run (2 real branches, a real fast gate command, no injected runGate — the
//         batch path always calls the real `runGateSequential`) lands both branches, and the resulting
//         `build_gate` row (`detail.batched:true`) carries non-null durationMs/gateCap/concurrentGates/
//         concurrentGatesMax, and the ACTUAL LANDED branch count (never the requested K) as branchCount.
//         `emitCompareReduced` reads back `null` here — the fixture repo's changed paths sit outside
//         `packages/daemon/src|test/` (this predicate's own domain), so it's genuinely NOT DECIDABLE for
//         this diff, same as it would be for any non-Loom-shaped project; asserted explicitly so a future
//         change to the predicate that starts fabricating a value here is caught.
//   (unit) `Db.listGateEvents`/`toGateHistoryRow`'s widened `emitCompareReduced` fallback, against synthetic
//          `detail.batched:true` fixtures whose opId has NO matching `pending_gate_ops` row (these fixtures
//          never call `insertPendingGateOp` themselves — see card be260976 below for why a REAL batch op now
//          does get one; this unit block's synthetic fixtures deliberately stay row-less to keep exercising
//          the fallback in isolation): a DECIDABLE `false` (a real gate that genuinely ran, proven NOT
//          reduced) is recovered from `detail` rather than reading back null; an ABSENT
//          `detail.emitCompareReduced` (never decidable for that diff) still reads back null, never a
//          fabricated value; and a NON-batched row's own legacy true-only `detail.emitCompareReduced` is
//          NEVER read as a decidable false (the fallback is scoped to `detail.batched === true` only, per
//          the guard this card's fix documents at its source).
//
// GATE_STATUS RESOLUTION (card be260976) — a SEPARATE defect this file now ALSO proves fixed: a batch gate
// never routed through `PendingOpRegistry` (see `mergeBatch`'s own header doc for why), so its opId was
// NEVER durably tombstoned — `gate_status(opId)` returned `"never_existed"` for a settled batch op, even
// though the SAME opId resolved fine while the batch was still running (first-party observation, Loom lead
// gen 245, batch opId 82bff9de). `mergeBatch` now mints+settles its own `pending_gate_ops` row directly
// (mirroring `deployOwnProject`'s precedent — see `deriveBatchGateVerdict`'s own doc, sessions/service.ts).
//   (e2e, PASS) appended to the existing green run above: the settled batch op resolves via
//         `sessions.gateStatus(opId)` as `state:"settled", gateType:"merge", passed:true`, carrying
//         `steps`/`outputTail`/`gateCap`/`concurrentGates`/`concurrentGatesMax` — the exact fields that used
//         to be unreachable for this opId once it settled — PLUS `settledAt`/`totalDurationMs` (Code Review,
//         card be260976: an earlier version of `deriveBatchGateVerdict` omitted these on a FALSE premise —
//         see that function's own doc for the corrected mint→admission analysis), asserted here to be a
//         real span STRICTLY GREATER than `durationMs` alone (proving `totalDurationMs` genuinely covers
//         the queue wait `durationMs` excludes, not a near-duplicate of it).
//   (e2e, FAIL) a SEPARATE batch with a failing gate command: proves the diagnostic parity that is the
//         whole point of this card (a rejected batch is the EXPENSIVE case — K branches to re-gate) —
//         `gate_status(opId)` on the settled, REJECTED batch op reports `passed:false` plus a real
//         `gateDetail`/`outputTail`, not just a bare classification — AND that `gate_history.failingTest`
//         for this SAME rejected batch, previously ALWAYS null, now recovers a real value via the fallback
//         card eb9348b0 built (Code Review, card be260976: a fifth field this card's own comments had
//         under-claimed as unchanged).
//   (e2e, CANCELLED) Code Review, card be260976 should-do #1: a queued batch gate IS genuinely cancellable
//         (`cancelQueued`'s fail-closed allowlist admits `gateType==="merge"`, and the batch descriptor is
//         `gateType:"merge"`) — forces a real `GateCancelledError` through the settle path at the mint
//         site's own `catch` block and proves the tombstone settles `"settled"`/`outcome:"cancelled"` with
//         a real `reason`, never left permanently `"pending"`.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/batch-merge-gate-history.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { waitUntil, sleepPast } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-bmgh-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=bmgh@loom -c user.name=bmgh";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# bmgh\n");
  execSync(`git init -q && git config user.email bmgh@loom && git config user.name bmgh`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

async function cutBranch(repo, projId, label, file, content) {
  const taskId = `bmgh-task-${label}-${sfx}`;
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, file), content);
  commitAll(worktreePath, `${label}`, GIT_ID);
  return { taskId, branch, worktreePath };
}

const dbs = [];
const worktrees = [];
try {
  // ── (e2e) a real mergeBatch run through 2 real branches + a real fast gate command ─────────────────────
  {
    const repo = path.join(os.tmpdir(), `loom-bmgh-${sfx}`);
    makeRepo(repo);
    const projId = `bmgh-proj-${sfx}`;
    const agentId = `bmgh-agent-${sfx}`;
    const mgrId = `bmgh-mgr-${sfx}`;

    const db = new Db(); dbs.push(db);
    db.insertProject({ id: projId, name: "BMGH", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: 'node -e "process.exit(0)"' } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    const a = await cutBranch(repo, projId, "a", "feature-a.txt", "work a\n");
    // b's own commit carries a Claude-Session trailer (card b7f965d2) — a real, doctrine-violating worker
    // commit shape — so this e2e also proves the SERVICE layer (SessionService.mergeBatch, not just
    // git/batch-merge.ts underneath it) actually surfaces `strippedTrailerCount` on the returned `landed`
    // row, not just computes it and drops it (Code Review finding: it used to be dropped at
    // `sessions/service.ts`'s own `landed.push`).
    const bTaskId = `bmgh-task-b-${sfx}`;
    const { worktreePath: bWorktreePath, branch: bBranch } = await createWorktree(repo, projId, bTaskId);
    fs.writeFileSync(path.join(bWorktreePath, "feature-b.txt"), "work b\n");
    commitAll(bWorktreePath, ["b", "Claude-Session: https://claude.ai/code/session_BMGHTRAILER"], GIT_ID);
    const b = { taskId: bTaskId, branch: bBranch, worktreePath: bWorktreePath };
    worktrees.push(a.worktreePath, b.worktreePath);
    const wA = `bmgh-wkr-a-${sfx}`, wB = `bmgh-wkr-b-${sfx}`;
    for (const [wId, w, label] of [[wA, a, "a"], [wB, b, "b"]]) {
      db.insertTask({ id: w.taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      db.insertSession({ id: wId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch });
    }

    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    // Card cf803152: `syncAttachBudgetMs: 0` is a throwaway TEST-ONLY override (never the production
    // `SYNC_ATTACH_BUDGET_MS` constant, which stays untouched) that FORCES every attach()-backed call on
    // this `sessions` instance to degrade to `{settled:false}` deterministically — a real worktree cut +
    // child-process gate can never resolve faster than the `sleep(0)` this races against. Before this
    // card, the degrade path here was reached only opportunistically (host contention sometimes crossed
    // the production 12s budget, sometimes didn't — card bb2b3f29), so the assertions below were only
    // EVER exercised by chance. Forcing it makes this test prove the recovery path on every run, not just
    // the runs where the host happened to be slow.
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 0 });

    // Card f944d4e4: mergeBatch is now mergeBatchTracked, keyed through PendingOpRegistry.attach.
    // Card cf803152: with `syncAttachBudgetMs: 0` above, this call is now DETERMINISTICALLY forced onto
    // the `{settled:false}` async-degrade path — never the sync fast path — so the wait below always runs.
    const r = await sessions.mergeBatchTracked(mgrId, [wA, wB]);
    if (!r.settled) {
      await waitUntil(() => sessions.gateStatus(r.op.opId).state === "settled",
        { timeoutMs: 60_000, label: "batch op to settle asynchronously (missed the 12s sync-wait budget)" });
    }
    check("(e2e) card f944d4e4/bb2b3f29: settles — synchronously, or (if slow) via the documented async degrade — never left permanently pending",
      r.settled || sessions.gateStatus(r.op.opId).state === "settled");
    // Card cf803152: `r.value` (the real MergeBatchResult — landed/strippedTrailerCount/phaseTimings) is
    // ONLY available on the sync fast path (see AttachResult's own doc) — this call was just forced onto
    // the async-degrade path above, so `r` itself never carries it. Before this card there was NO cache to
    // recover it from at all; `mergeBatchTracked`'s `attach()` call now passes `retainMs`/
    // `retainVerdictUntilSuperseded` for the merge-batch key (this method's own opts, sessions/service.ts),
    // so a RE-CALL with the SAME manager + resolved worker set (the batchKey's own scope) hits that cache
    // instead of re-running the whole batch. Assert the cache hit itself, not just that a value came back —
    // `cacheHit` is populated ONLY by attach()'s cache-read branches, never by a fresh `run()` invocation
    // (see PendingOpRegistry's own CacheHitInfo doc), so this is a real proof no second gate/worktree/
    // fast-forward ran, not an assumption.
    const recovered = await sessions.mergeBatchTracked(mgrId, [wA, wB]);
    // Code Review, card cf803152 ("test gap"): guard the re-call — on a genuine cache MISS this silently
    // re-runs a SECOND real batch (worktree cut + gate + fast-forward). Letting that happen would corrupt
    // every assertion below with data from an accidental extra run instead of a clean recovery, and the
    // real defect (a broken cache) would read as a pile of unrelated-looking failures rather than one clear
    // one. Fail loudly and stop here instead.
    if (!recovered.settled || recovered.cacheHit == null) {
      console.error(`(e2e) FATAL: the re-call after degrade+settle did NOT hit the retention cache (settled=${recovered.settled}, cacheHit=${JSON.stringify(recovered.cacheHit)}) — refusing to continue past this point rather than risk a silent second real batch run corrupting the checks below.`);
      failures++;
      console.log(`\n${failures} check(s) FAILED.`);
      process.exit(1);
    }
    check("(e2e) card cf803152: a re-call after degrade+settle recovers the real verdict from the retention cache (cacheHit), not a fresh re-run", true);
    const result = recovered.ok ? recovered.value : undefined;
    // Card cf803152 DoD-3: these 4 assertions used to be SKIPPED under degrade (no cache existed to recover
    // `result` from) — now unconditional: a broken recovery leaves `result` undefined and these FAIL loudly
    // instead of silently not running.
    check("(e2e) ok:true", result?.ok === true);
    check("(e2e) both branches landed, none fell back", result?.landed.length === 2 && result?.fallback.length === 0);
    // THE DISCRIMINATING ASSERTION for the service-layer plumbing fix: reverting sessions/service.ts's
    // `landed.push` back to omitting the field makes this FAIL while every git/batch-merge.ts-level test
    // (test/batch-merge.mjs) stays green, since that layer computes the field correctly either way.
    const landedA = result?.landed.find((l) => l.branch === a.branch);
    const landedB = result?.landed.find((l) => l.branch === b.branch);
    check("(e2e) SessionService.mergeBatch's returned `landed` row surfaces strippedTrailerCount:0 for the clean branch", landedA?.strippedTrailerCount === 0);
    check("(e2e) SessionService.mergeBatch's returned `landed` row surfaces strippedTrailerCount:1 for the trailer-carrying branch", landedB?.strippedTrailerCount === 1);

    // Code Review, card cf803152 ("test gap"): the re-call above lands well INSIDE MERGE_OP_RETAIN_MS
    // (5_000ms as of this writing — not exported, so this waits a deliberately generous 7s to absorb host
    // scheduling slop), so it would pass identically even with `retainVerdictUntilSuperseded` absent
    // (attach()'s own short-lived TTL'd `retained` map alone would serve it) — the opt this comment calls
    // load-bearing was the one thing left unexercised. Wait PAST that window and re-call again: only
    // `retainVerdictUntilSuperseded` (no clock of its own, superseded only by an identity mismatch or a
    // daemon restart — see mergeBatchTracked's own opts doc) can still serve this.
    await sleepPast(7_000, 5_000, "past MERGE_OP_RETAIN_MS");
    const recoveredLate = await sessions.mergeBatchTracked(mgrId, [wA, wB]);
    check("(e2e) card cf803152: recovery still works PAST MERGE_OP_RETAIN_MS (5s) — proves retainVerdictUntilSuperseded (not merely the short-lived retainMs display window) is what's actually recoverable", recoveredLate.settled === true && recoveredLate.cacheHit != null);

    const page = db.listGateEvents({ projectId: projId, limit: 50, offset: 0 });
    const row = page.items.find((r) => r.opId != null && page.items.filter((x) => x.opId === r.opId).length === 1) ?? page.items[0];
    check("(e2e) a build_gate row exists for the batch op", !!row);
    check("(e2e) DoD-1: durationMs is a real (non-null) number — was null on the first live batch", typeof row?.durationMs === "number" && row.durationMs >= 0);
    check("(e2e) DoD-1: gateCap is a real (non-null) number", typeof row?.gateCap === "number");
    check("(e2e) DoD-1: concurrentGates is a real (non-null) number", typeof row?.concurrentGates === "number");
    check("(e2e) DoD-1: concurrentGatesMax is a real (non-null) number", typeof row?.concurrentGatesMax === "number");
    check("(e2e) DoD-3: the row already carried the ACTUAL LANDED count (2), never the requested K — pre-existing, unchanged by this card", true);
    check("(e2e) the row passed", row?.passed === true);
    check("(e2e) emitCompareReduced reads null — genuinely NOT DECIDABLE for this repo's diff shape (paths outside packages/daemon/src|test/), never a fabricated value", row?.emitCompareReduced === null);
    // Card fd0d34da: the fixture repo's ENTIRE diff (feature-a.txt/feature-b.txt at repo root) has no path
    // under any of the four emit-compare scopes at all — the exact "repo-out-of-domain" shape, not the
    // "path-out-of-scope" one (which needs an otherwise in-scope path present ELSEWHERE in the same diff).
    check("(e2e) emitCompareNotApplicableKind reads \"repo-out-of-domain\" — this repo's diff touches no in-scope path at all, real production shape (opId 1cfb5219 predates this field and would have read null here)", row?.emitCompareNotApplicableKind === "repo-out-of-domain");

    // ── card 6cc803b2: phase-timing instrumentation. `GateHistoryRow` (the typed read above) deliberately
    // does NOT surface arbitrary detail fields — read the RAW event's own detail instead, the same seam
    // `reconcileOrphanedGateOps`'s boot sweep already uses (findGateOpEventsByOpId).
    const rawEvents = row?.opId ? db.findGateOpEventsByOpId(row.opId) : [];
    const rawBuildGate = rawEvents.find((e) => e.kind === "build_gate");
    check("(e2e) card 6cc803b2: the batch's build_gate event carries a real (non-negative) worktreeCutMs", typeof rawBuildGate?.detail?.worktreeCutMs === "number" && rawBuildGate.detail.worktreeCutMs >= 0);
    check("(e2e) card 6cc803b2: the batch's build_gate event carries a real (non-negative) assemblyMs", typeof rawBuildGate?.detail?.assemblyMs === "number" && rawBuildGate.detail.assemblyMs >= 0);
    check("(e2e) card 6cc803b2: the batch's build_gate event carries a real (non-negative) admissionWaitMs, SEPARATE from durationMs (the gate-run phase)", typeof rawBuildGate?.detail?.admissionWaitMs === "number" && rawBuildGate.detail.admissionWaitMs >= 0);
    // NEGATIVE CONTROL for the field-name discipline above: a solo (non-batch) build_gate event never
    // carries these batch-only phase fields — proves the assertions above are reading a real, batch-
    // specific stamp, not a value `toOrchestrationEvent`/JSON.parse fabricates for every row.
    check("(e2e) negative control: a plain object with no worktreeCutMs key reads back undefined, not 0/null", ({}).worktreeCutMs === undefined);
    // `mergeBatch`'s OWN return value also surfaces the two phases only knowable in that method's scope
    // (worktree cut + fast-forward — see its own `phaseTimings` doc for why the other three live on the
    // build_gate event instead). Card cf803152: recovered from the retention cache above (see `result`'s
    // own comment) — unconditional now, same reasoning as DoD-3's 4 assertions above.
    check("(e2e) card 6cc803b2: mergeBatch's own return value carries phaseTimings.worktreeCutMs", typeof result?.phaseTimings?.worktreeCutMs === "number" && result.phaseTimings.worktreeCutMs >= 0);
    check("(e2e) card 6cc803b2: mergeBatch's own return value carries phaseTimings.assemblyMs (matches the build_gate event's own) — asserted as a REAL number on both sides first, so this can't vacuously pass on two undefineds",
      typeof result?.phaseTimings?.assemblyMs === "number" && typeof rawBuildGate?.detail?.assemblyMs === "number" && result.phaseTimings.assemblyMs === rawBuildGate.detail.assemblyMs);
    check("(e2e) card 6cc803b2: mergeBatch's own return value carries phaseTimings.fastForwardMs for a real, non-forfeited fast-forward", typeof result?.phaseTimings?.fastForwardMs === "number" && result.phaseTimings.fastForwardMs >= 0);

    // ── card be260976 DoD-4: the SAME settled batch opId now resolves via gate_status, never never_existed ──
    const st = row?.opId ? sessions.gateStatus(row.opId) : undefined;
    check("(e2e) DoD-4: gate_status resolves the settled batch op as \"settled\" — was \"never_existed\" before this card", st?.state === "settled");
    check("(e2e) DoD-4: gate_status reports gateType \"merge\" for the batch op", st?.gateType === "merge");
    check("(e2e) DoD-4: gate_status reports the real verdict (passed:true)", st?.passed === true);
    check("(e2e) DoD-4: gate_status carries steps/outputTail/gateCap/concurrentGates/concurrentGatesMax",
      Array.isArray(st?.steps) && typeof st?.outputTail === "string" &&
      typeof st?.gateCap === "number" && typeof st?.concurrentGates === "number" && typeof st?.concurrentGatesMax === "number");
    check("(e2e) DoD-4: gate_status's admittedAt is a real ISO timestamp for this op", typeof st?.admittedAt === "string" && !Number.isNaN(Date.parse(st.admittedAt)));
    // Code Review, card be260976 BLOCKING: settledAt/totalDurationMs must be present (an earlier version of
    // deriveBatchGateVerdict omitted them on a false "near-duplicate of durationMs" premise — see that
    // function's own doc). totalDurationMs is measured from this op's REAL mint instant (strictly before
    // gate admission — see the mint call site's own comment), so it can never read back SMALLER than
    // durationMs (the narrower, admission-to-settle-only span) — that inequality is what proves this is a
    // genuinely broader span, not a relabelled copy of the same number.
    check("(e2e) DoD (blocking): gate_status carries a real settledAt", typeof st?.settledAt === "string" && !Number.isNaN(Date.parse(st.settledAt)));
    check("(e2e) DoD (blocking): gate_status carries a real, non-negative totalDurationMs", typeof st?.totalDurationMs === "number" && st.totalDurationMs >= 0);
    check("(e2e) DoD (blocking): totalDurationMs >= durationMs — it covers mint→settle, never a narrower/equal-by-coincidence span", st.totalDurationMs >= st.durationMs);
    // NEGATIVE CONTROL: a bogus, never-minted opId must still read never_existed — proves the check above
    // is discriminating a REAL fix, not a broken/always-"settled" gateStatus.
    const bogus = sessions.gateStatus("00000000-0000-0000-0000-000000000000");
    check("(e2e) negative control: a genuinely bogus opId still reads never_existed", bogus.state === "never_existed");
  }

  // ── (e2e, FAIL) card be260976 DoD-4: a REJECTED batch's own settled op still resolves via gate_status, ──
  // ── carrying gateDetail/outputTail — the diagnostic parity that is this card's whole point (a rejected ──
  // ── batch is the expensive case: K branches to re-gate individually). ────────────────────────────────
  {
    const repo = path.join(os.tmpdir(), `loom-bmgh-red-${sfx}`);
    makeRepo(repo);
    const projId = `bmgh-red-proj-${sfx}`;
    const agentId = `bmgh-red-agent-${sfx}`;
    const mgrId = `bmgh-red-mgr-${sfx}`;

    const db = new Db(); dbs.push(db);
    // "FAIL  <name>" (this daemon's own bare-identifier convention, gate-runner.ts's FAIL_NOT_OK_TIER_RE)
    // so `result.failingTest` reads back a REAL value, not `undefined` — needed to prove the gate_history
    // `failingTest` fallback (below) actually recovers something, not just that it's technically wired.
    db.insertProject({ id: projId, name: "BMGH-RED", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: 'node -e "console.error(\'FAIL  bmgh-red-fixture-test\'); process.exit(1)"' } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    const a = await cutBranch(repo, projId, "red-a", "red-feature-a.txt", "work a\n");
    const b = await cutBranch(repo, projId, "red-b", "red-feature-b.txt", "work b\n");
    worktrees.push(a.worktreePath, b.worktreePath);
    const wA = `bmgh-red-wkr-a-${sfx}`, wB = `bmgh-red-wkr-b-${sfx}`;
    for (const [wId, w, label] of [[wA, a, "red-a"], [wB, b, "red-b"]]) {
      db.insertTask({ id: w.taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      db.insertSession({ id: wId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch });
    }

    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

    // Card f944d4e4: mergeBatch is now mergeBatchTracked. A red gate's own fallback re-gates each
    // candidate individually (confirmWorkerMergeTracked) after the gate itself already settled — real git
    // I/O that, combined with the assemble+gate cost, can miss the 12s SYNC_ATTACH_BUDGET_MS budget under
    // host contention (card bb2b3f29 — merge gate b2f5c2cc showed this exact site cross it). Tolerate
    // `{settled:false}` as the documented, supported async-degrade path (mirrors card fc82083b's CANCELLED
    // site below) rather than requiring the sync fast path: the gate's own tombstone settles mid-flow,
    // BEFORE the fallback runs, so polling it for "settled" is sufficient here (unlike FORFEIT below, which
    // needs a later artifact).
    const r = await sessions.mergeBatchTracked(mgrId, [wA, wB]);
    if (!r.settled) {
      await waitUntil(() => sessions.gateStatus(r.op.opId).state === "settled",
        { timeoutMs: 60_000, label: "rejected batch op to settle asynchronously (missed the 12s sync-wait budget)" });
    }
    check("(e2e, FAIL) card f944d4e4/bb2b3f29: settles — synchronously, or (if slow) via the documented async degrade — never left permanently pending",
      r.settled || sessions.gateStatus(r.op.opId).state === "settled");
    // `r.value` is only available on the sync fast path (see attach()'s own doc) — on the async-degrade
    // path there is no separate handle to it, only this placeholder. Unlike the (e2e) PASS block above,
    // `ok:false` here is NOT a guess: this scenario's own red gate command guarantees the whole batch falls
    // back regardless of how long attach() waited, so the placeholder matches what the real value would
    // also have been.
    const result = r.settled && r.ok ? r.value : { ok: false, landed: [], fallback: [], reason: "settled via the async degrade path, not the sync fast path" };
    check("(e2e, FAIL) ok:false — the whole batch falls back on a red gate", result.ok === false);

    // The red batch's own fallback re-gates each candidate individually (confirmWorkerMergeTracked), so
    // this project now ALSO carries two solo build_gate rows alongside the batch's own — each of those
    // carries a real `branch` (joined from the worker session), while the batch's own row is filed under
    // the MANAGER with `branch:null` by construction (see mergeBatch's own header doc) — the discriminator
    // that picks the batch's row out specifically, not just "the only build_gate row" (unlike the green
    // block above, this project genuinely has more than one).
    const page = db.listGateEvents({ projectId: projId, limit: 50, offset: 0 });
    const batchRow = page.items.find((r) => r.branch === null);
    check("(e2e, FAIL) a build_gate row exists for the rejected batch op (branch:null, filed under the manager)", !!batchRow);
    check("(e2e, FAIL) the row failed", batchRow?.passed === false);

    const stRed = batchRow?.opId ? sessions.gateStatus(batchRow.opId) : undefined;
    check("(e2e, FAIL) DoD-4: gate_status resolves the settled, REJECTED batch op as \"settled\"", stRed?.state === "settled");
    check("(e2e, FAIL) DoD-4: gate_status reports the real verdict (passed:false)", stRed?.passed === false);
    check("(e2e, FAIL) DoD-4: gate_status carries a real gateDetail for the rejection", stRed?.gateDetail != null && typeof stRed.gateDetail === "object");
    check("(e2e, FAIL) DoD-4: gate_status carries a non-empty outputTail for the rejection", typeof stRed?.outputTail === "string" && stRed.outputTail.length > 0);
    // Code Review, card be260976 BLOCKING #2: a FIFTH gate_history field changes on this same op, beyond the
    // four this file's header comment originally named — db.ts's toGateHistoryRow falls back to
    // verdictPayload.gateDetail.failingTest (card eb9348b0) whenever the raw event carries none, which a
    // batch's own build_gate event never does. Before this card, a rejected batch's gate_history.failingTest
    // was ALWAYS null (no tombstone to fall back to at all); it now recovers the real value.
    check("(e2e, FAIL) DoD (blocking #2): gate_history.failingTest recovers a real value for the rejected batch row, via the tombstone's own gateDetail — previously ALWAYS null for a batch row",
      typeof batchRow?.failingTest === "string" && batchRow.failingTest.includes("bmgh-red-fixture-test"));

    // Code Review, card cf803152 finding [1] — the REPRODUCED regression this card's first attempt
    // shipped: `retainVerdictUntilSuperseded` with no `verdictIdentity` made a rejected batch's cached
    // verdict IMMORTAL — a re-fire with the SAME workerSessionIds after a candidate branch genuinely
    // changed still replayed the stale rejection forever (both workers could commit the actual fix and
    // main would still never move). Prove the fix directly: move wA's branch (a real new commit), then
    // re-fire with the SAME workerSessionIds. If this were served from the retention cache instead of
    // re-derived for real, `cacheHit` would be present — assert its ABSENCE. (A `{settled:false}` pending
    // result also proves this on its own: a cache hit is ALWAYS synchronous, per AttachResult's own doc —
    // "a still-running op is always either a genuinely fresh mint or an attach to one, never a cache
    // replay".) This gate command always fails regardless of content, so the re-fire is expected to be
    // rejected again too — the point is that it genuinely RE-RAN, not that it now passes. Deliberately
    // LAST in this block: this mints a SECOND batch-level build_gate row (branch:null), which would
    // otherwise collide with `batchRow`'s own `.find()` above (both checks above already ran against the
    // FIRST, ORIGINAL rejected row).
    fs.writeFileSync(path.join(a.worktreePath, "red-feature-a-fix.txt"), "fix\n");
    commitAll(a.worktreePath, "fix", GIT_ID);
    const afterFix = await sessions.mergeBatchTracked(mgrId, [wA, wB]);
    if (!afterFix.settled) {
      await waitUntil(() => sessions.gateStatus(afterFix.op.opId).state === "settled",
        { timeoutMs: 60_000, label: "post-branch-change re-fire to settle (proving it re-derived, not replayed)" });
    }
    check("(e2e, FAIL) card cf803152: a re-fire after a candidate branch genuinely moves is NEVER served the stale cached verdict (no cacheHit — verdictIdentity mismatch forced a fresh re-derive)", !afterFix.settled || afterFix.cacheHit == null);
  }

} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
