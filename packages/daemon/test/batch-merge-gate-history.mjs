import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
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
  execSync(`git init -q && git config user.email bmgh@loom && git config user.name bmgh && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

async function cutBranch(repo, projId, label, file, content) {
  const taskId = `bmgh-task-${label}-${sfx}`;
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, file), content);
  execSync(`git add . && git ${GIT_ID} commit -q -m "${label}"`, { cwd: worktreePath });
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
    execSync(`git add . && git ${GIT_ID} commit -q -m "b" -m "Claude-Session: https://claude.ai/code/session_BMGHTRAILER"`, { cwd: bWorktreePath });
    const b = { taskId: bTaskId, branch: bBranch, worktreePath: bWorktreePath };
    worktrees.push(a.worktreePath, b.worktreePath);
    const wA = `bmgh-wkr-a-${sfx}`, wB = `bmgh-wkr-b-${sfx}`;
    for (const [wId, w, label] of [[wA, a, "a"], [wB, b, "b"]]) {
      db.insertTask({ id: w.taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      db.insertSession({ id: wId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch });
    }

    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

    const result = await sessions.mergeBatch(mgrId, [wA, wB]);
    check("(e2e) ok:true", result.ok === true);
    check("(e2e) both branches landed, none fell back", result.landed.length === 2 && result.fallback.length === 0);
    // THE DISCRIMINATING ASSERTION for the service-layer plumbing fix: reverting sessions/service.ts's
    // `landed.push` back to omitting the field makes this FAIL while every git/batch-merge.ts-level test
    // (test/batch-merge.mjs) stays green, since that layer computes the field correctly either way.
    const landedA = result.landed.find((l) => l.branch === a.branch);
    const landedB = result.landed.find((l) => l.branch === b.branch);
    check("(e2e) SessionService.mergeBatch's returned `landed` row surfaces strippedTrailerCount:0 for the clean branch", landedA?.strippedTrailerCount === 0);
    check("(e2e) SessionService.mergeBatch's returned `landed` row surfaces strippedTrailerCount:1 for the trailer-carrying branch", landedB?.strippedTrailerCount === 1);

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

    const result = await sessions.mergeBatch(mgrId, [wA, wB]);
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
  }

  // ── (e2e, CANCELLED) Code Review, card be260976 should-do #1 — a QUEUED batch gate is genuinely ──
  // ── cancellable (cancelQueued's fail-closed allowlist admits gateType==="merge"; the batch's own ──
  // ── descriptor is gateType:"merge" — gate-semaphore.ts). This is the ONLY thing standing between a ──
  // ── real cancel and a permanently-"pending" tombstone (the mint site's own `catch` block) — prove it ──
  // ── actually fires and the row settles cleanly. ──────────────────────────────────────────────────
  {
    const repo = path.join(os.tmpdir(), `loom-bmgh-cancel-${sfx}`);
    makeRepo(repo);
    const projId = `bmgh-cancel-proj-${sfx}`;
    const agentId = `bmgh-cancel-agent-${sfx}`;
    const mgrId = `bmgh-cancel-mgr-${sfx}`;

    const db = new Db(); dbs.push(db);
    // No maxConcurrentGates override — the resolved default is 1 (packages/shared/src/types.ts), matching
    // the holder's own runExclusive(1, ...) below, so the batch's own gate request is GUARANTEED to queue
    // behind it rather than racing in alongside it (GateSemaphore.acquire admits immediately whenever
    // active < cap, regardless of which caller asked — the holder's cap and this project's resolved cap
    // must agree for the queue to be real).
    db.insertProject({ id: projId, name: "BMGH-CANCEL", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: 'node -e "process.exit(0)"' } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    const a = await cutBranch(repo, projId, "cxl-a", "cxl-feature-a.txt", "work a\n");
    const b = await cutBranch(repo, projId, "cxl-b", "cxl-feature-b.txt", "work b\n");
    worktrees.push(a.worktreePath, b.worktreePath);
    const wA = `bmgh-cxl-wkr-a-${sfx}`, wB = `bmgh-cxl-wkr-b-${sfx}`;
    for (const [wId, w, label] of [[wA, a, "cxl-a"], [wB, b, "cxl-b"]]) {
      db.insertTask({ id: w.taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      db.insertSession({ id: wId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch });
    }

    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

    // Seize the ONE gate slot via an UNRELATED descriptor/project, held open until releaseHolder() fires —
    // the same established pattern merge-gate-reuse.mjs uses to force a real op to genuinely queue.
    let releaseHolder;
    const holderPromise = new Promise((resolve) => { releaseHolder = resolve; });
    const holderRun = sessions.gateSemaphore.runExclusive(
      1, { gateType: "merge", projectId: `bmgh-cancel-holder-${sfx}`, sessionId: "bmgh-cancel-holder-sess" }, () => holderPromise,
    );

    const batchPromise = sessions.mergeBatch(mgrId, [wA, wB]);

    // Poll until the batch's OWN gate request is genuinely queued behind the holder — deterministic (reads
    // live semaphore state), not a timed guess; bounded so a real regression fails fast rather than hanging
    // the suite.
    const queueDeadline = Date.now() + 20_000;
    let queuedEntry;
    while (Date.now() <= queueDeadline) {
      queuedEntry = sessions.gateSemaphore.snapshot().entries.find((e) => e.phase === "queued" && e.projectId === projId);
      if (queuedEntry) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    check("(e2e, CANCELLED) precondition: the batch's own gate request is genuinely queued behind the holder", !!queuedEntry);

    if (!queuedEntry) {
      // Precondition unmet — release the holder so nothing is left dangling, let the batch settle on its
      // own, and skip the state-dependent assertions below (meaningless without the precondition).
      releaseHolder();
      await Promise.allSettled([holderRun, batchPromise]);
    } else {
      const cancelOk = sessions.gateSemaphore.cancelQueued(queuedEntry.id, "manual", "test cancel of a queued batch gate");
      check("(e2e, CANCELLED) cancelQueued accepts a queued batch (gateType:\"merge\") entry", cancelOk === true);
      releaseHolder();
      await holderRun;

      const result = await batchPromise;
      check("(e2e, CANCELLED) ok:false — a cancelled batch gate falls back, same as a red one", result.ok === false);

      const stCancelled = queuedEntry.opId ? sessions.gateStatus(queuedEntry.opId) : undefined;
      check("(e2e, CANCELLED) the tombstone settles \"settled\", never left permanently \"pending\"", stCancelled?.state === "settled");
      check("(e2e, CANCELLED) gate_status reports outcome \"cancelled\"", stCancelled?.outcome === "cancelled" && stCancelled?.cancelled === true);
      check("(e2e, CANCELLED) gate_status carries a real reason naming the cancel", typeof stCancelled?.reason === "string" && stCancelled.reason.length > 0);
      check("(e2e, CANCELLED) gate_status carries settledAt/totalDurationMs on the cancelled path too (mirrors deriveMergeGateVerdict's own cancelled branch)",
        typeof stCancelled?.settledAt === "string" && typeof stCancelled?.totalDurationMs === "number" && stCancelled.totalDurationMs >= 0);
    }
  }

  // ── (unit) toGateHistoryRow's widened emitCompareReduced fallback for a batched row with NO pending_gate_ops row at all ──
  {
    const db = new Db(); dbs.push(db);
    const P = `bmgh-unit-${sfx}`;
    db.insertProject({ id: P, name: "BMGH-UNIT", repoPath: `/tmp/${P}`, vaultPath: `/tmp/${P}`, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    const mgr = `${P}-mgr`;
    db.insertAgent({ id: `${P}-a`, projectId: P, name: "dev", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgr, projectId: P, agentId: `${P}-a`, engineSessionId: null, title: null, cwd: `/tmp/${P}`, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    // A DECIDABLE false — a real batch gate that genuinely ran and was proven NOT reduced. No matching
    // pending_gate_ops row exists for this opId at all (mirrors real batch reality exactly).
    const opDecidedFalse = randomUUID();
    db.appendEvent({
      id: randomUUID(), ts: new Date(Date.now() - 3000).toISOString(), managerSessionId: mgr, kind: "build_gate",
      detail: { opId: opDecidedFalse, passed: true, batched: true, branchCount: 2, durationMs: 12345, gateCap: 2, concurrentGates: 1, concurrentGatesMax: 2, emitCompareReduced: false },
    });
    // NOT decidable for this diff (the producer never stamped the field at all) — must stay null, never a
    // fabricated false/true.
    const opUndecidable = randomUUID();
    db.appendEvent({
      id: randomUUID(), ts: new Date(Date.now() - 2000).toISOString(), managerSessionId: mgr, kind: "build_gate",
      detail: { opId: opUndecidable, passed: true, batched: true, branchCount: 3, durationMs: 6789, gateCap: 2, concurrentGates: 1, concurrentGatesMax: 1 },
    });
    // Negative control: a NON-batched row's own legacy true-only detail must never be read as a decidable
    // false via this fallback — a real gate never stamps an explicit false there (see the fallback's own
    // scoping doc in db.ts), so this proves the `detail.batched === true` guard is load-bearing, not
    // vacuous: if the guard were dropped, this row's absent field would still read null either way, so the
    // real proof is the DECIDABLE-false case above going RED without the guard — this row is the shape the
    // guard exists to keep OUT of the fallback, asserted for completeness.
    const opSolo = randomUUID();
    db.appendEvent({
      id: randomUUID(), ts: new Date(Date.now() - 1000).toISOString(), managerSessionId: mgr, kind: "build_gate",
      detail: { opId: opSolo, passed: true, durationMs: 999, gateCap: 2, concurrentGates: 1, concurrentGatesMax: 1 },
    });

    const page = db.listGateEvents({ projectId: P, limit: 50, offset: 0 });
    const decidedFalse = page.items.find((r) => r.opId === opDecidedFalse);
    const undecidable = page.items.find((r) => r.opId === opUndecidable);
    const solo = page.items.find((r) => r.opId === opSolo);
    check("(unit) a batched row's DECIDABLE false is recovered from detail, not left null", decidedFalse?.emitCompareReduced === false);
    check("(unit) the SAME row's durationMs/gateCap/concurrentGates/concurrentGatesMax read back intact", decidedFalse?.durationMs === 12345 && decidedFalse?.gateCap === 2 && decidedFalse?.concurrentGates === 1 && decidedFalse?.concurrentGatesMax === 2);
    check("(unit) a batched row with NO emitCompareReduced in detail (undecidable) reads back null, never fabricated", undecidable?.emitCompareReduced === null);
    check("(unit) a non-batched row's own detail (no emitCompareReduced at all) reads back null, unaffected by this fallback", solo?.emitCompareReduced === null);
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
