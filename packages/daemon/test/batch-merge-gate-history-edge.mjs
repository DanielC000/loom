import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// SPLIT OFF batch-merge-gate-history.mjs (card 4e8e2d82): carries ONLY (e2e, CANCELLED), (e2e, FORFEIT) and
// (unit) from the description below; (e2e, PASS)/(e2e, FAIL) live in the sibling file. The comment below is
// the ORIGINAL combined file's — read it as covering both halves.
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
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/batch-merge-gate-history-edge.mjs
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

    // Card f944d4e4: mergeBatch is now mergeBatchTracked (returns AttachResult<MergeBatchResult>) — cancel
    // + release happen within milliseconds of the queue precondition being observed, but a CANCELLED batch
    // gate does not stop there: it falls back to a full SEQUENTIAL per-branch re-confirm (assemble + 2 real
    // squash-merge+gate cycles, one worker at a time), and that real git I/O can legitimately push the
    // TOTAL wall time past `SYNC_ATTACH_BUDGET_MS` (12s — pending-ops.ts's own doc: sized for "a typical
    // fast merge/spawn", not this compound cascade). Card fc82083b measured this directly: on the SAME
    // host, in the SAME run, this scenario's own fallback call alone took ~8-9s versus ~5s for this file's
    // FAIL/FORFEIT blocks' structurally-identical fallback call — consistently heavier, not merely
    // noisier — and the combined total (~3s assembly + ~8-9s fallback) sits close enough to the 12s budget
    // that whether `batchPromise` settles synchronously is a coin flip on real host timing. Below, this
    // treats a `{settled:false}` degrade as the NORMAL, DOCUMENTED outcome `PendingOpRegistry.attach` itself
    // supports (see its `onSurfacedPending`/`onSettledAfterPending`) rather than a failure, and polls the
    // batch's own gate tombstone for the eventual settle — mirroring gate-history.mjs's own
    // `{settled:false}`-then-poll pattern for exactly this class of op — instead of racing real git I/O
    // against a fixed budget it cannot always meet.
    const batchPromise = sessions.mergeBatchTracked(mgrId, [wA, wB]);

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

      const r = await batchPromise;
      if (!r.settled) {
        // Missed the sync-wait budget (see the comment above `batchPromise`) — the real op is still
        // running in the background under the SAME opId the gate descriptor carries (mergeBatchTracked's
        // own header doc). This is the documented async-degrade path, not a failure: wait for the
        // tombstone's own terminal state (asserted for real just below — a genuine wedge here still fails
        // the test, loudly, via waitUntil's own timeout) instead of requiring the sync fast path.
        await waitUntil(() => sessions.gateStatus(queuedEntry.opId).state === "settled",
          { timeoutMs: 60_000, label: "cancelled batch op to settle asynchronously (missed the 12s sync-wait budget)" });
      }
      // `r.value` is only available on the sync fast path (see attach()'s own doc) — on the async-degrade
      // path there is no separate handle to the eventual MergeBatchResult, only this placeholder; the
      // interesting verdict either way lives in `stCancelled` (the gate's own tombstone), read next.
      const result = r.settled && r.ok ? r.value : { ok: false, landed: [], fallback: [], reason: "settled via the async degrade path, not the sync fast path" };
      check("(e2e, CANCELLED) ok:false — a cancelled batch gate falls back, same as a red one", result.ok === false);

      const stCancelled = queuedEntry.opId ? sessions.gateStatus(queuedEntry.opId) : undefined;
      check("(e2e, CANCELLED) card fc82083b: settles — synchronously, or (if the fallback's real git I/O missed the sync-wait budget) via the documented async degrade — never left permanently \"pending\"", stCancelled?.state === "settled");
      check("(e2e, CANCELLED) gate_status reports outcome \"cancelled\"", stCancelled?.outcome === "cancelled" && stCancelled?.cancelled === true);
      check("(e2e, CANCELLED) gate_status carries a real reason naming the cancel", typeof stCancelled?.reason === "string" && stCancelled.reason.length > 0);
      check("(e2e, CANCELLED) gate_status carries settledAt/totalDurationMs on the cancelled path too (mirrors deriveMergeGateVerdict's own cancelled branch)",
        typeof stCancelled?.settledAt === "string" && typeof stCancelled?.totalDurationMs === "number" && stCancelled.totalDurationMs >= 0);
    }
  }

  // ── (e2e, FORFEIT) card 456f63a4 — the batch_merge_forfeited event now carries the REAL advanced-to ──
  // ── currentMainSha, previously computed by fastForwardCanonicalMain (git/batch-merge.ts) but dropped ──
  // ── before ever reaching RunBatchedMergeResult, hence never reaching sessions/service.ts's evtBatch ──
  // ── call. Forces a REAL forfeit through the actual SessionService.mergeBatch pipeline (not the ──
  // ── git/batch-merge.ts unit fixture in test/batch-merge.mjs): the gate command itself lands a real ──
  // ── commit on CANONICAL main while the batch gate is "running" — mirroring test/batch-merge.mjs's own ──
  // ── gateThatRacesMain, but via a real spawned process — then records the resulting HEAD to a file so ──
  // ── the test can assert the EMITTED VALUE against it, not merely that the key exists. ──────────────
  {
    const repo = path.join(os.tmpdir(), `loom-bmgh-forfeit-${sfx}`);
    makeRepo(repo);
    const projId = `bmgh-forfeit-proj-${sfx}`;
    const agentId = `bmgh-forfeit-agent-${sfx}`;
    const mgrId = `bmgh-forfeit-mgr-${sfx}`;
    const shaFile = path.join(os.tmpdir(), `loom-bmgh-forfeit-sha-${sfx}.txt`);

    const db = new Db(); dbs.push(db);
    // The gate command races main itself: it lands a real commit on the CANONICAL repo (not the batch
    // worktree) while "running", then APPENDS the resulting HEAD to shaFile — the batch's own
    // fast-forward check (right after ITS OWN gate step returns) must see canonical main has moved. This
    // SAME gateCommand also fires again for each candidate's individual fallback re-gate (mergeBatch's own
    // fallback path re-gates every originally-batched branch — see its DoD), so shaFile ends up with ONE
    // line per gate invocation, oldest first: line 1 is the sha the ORIGINAL batch gate produced (the one
    // fastForwardCanonicalMain actually observed and the forfeit event actually carries), later lines are
    // from the fallback's own re-gates and are deliberately NOT what this test compares against.
    const raceGateCmd = `git -C "${repo}" -c user.email=bmgh-forfeit@loom -c user.name=bmgh-forfeit commit -q -m race --allow-empty && git -C "${repo}" rev-parse HEAD >> "${shaFile}"`;
    db.insertProject({ id: projId, name: "BMGH-FORFEIT", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: raceGateCmd } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    const a = await cutBranch(repo, projId, "fbf-a", "fbf-feature-a.txt", "work a\n");
    const b = await cutBranch(repo, projId, "fbf-b", "fbf-feature-b.txt", "work b\n");
    worktrees.push(a.worktreePath, b.worktreePath);
    const wA = `bmgh-fbf-wkr-a-${sfx}`, wB = `bmgh-fbf-wkr-b-${sfx}`;
    for (const [wId, w, label] of [[wA, a, "fbf-a"], [wB, b, "fbf-b"]]) {
      db.insertTask({ id: w.taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      db.insertSession({ id: wId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch });
    }

    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

    // Card f944d4e4: mergeBatch is now mergeBatchTracked. A genuine forfeit falls back to individual
    // re-confirms too (same cost profile as FAIL/CANCELLED) — real git I/O that can miss the 12s
    // SYNC_ATTACH_BUDGET_MS budget under host contention (card bb2b3f29 — merge gate b2f5c2cc showed this
    // exact site cross it). Tolerate `{settled:false}` as the documented, supported async-degrade path
    // (mirrors card fc82083b's CANCELLED site above). UNLIKE the FAIL block above, the gate's own tombstone
    // settling is NOT enough here: `runGate`'s own settle happens BEFORE the fast-forward/forfeit check AND
    // the fallback even run (mergeBatch's outer flow does that work only after runGate returns) — so this
    // scenario's own downstream preconditions (the `batch_merge_forfeited` event, AND shaFile picking up the
    // fallback's own 2 re-gate lines) can still be unmet the instant gate_status first reports "settled", or
    // even the instant the forfeit event itself is filed (measured directly: waiting on the forfeit event
    // alone raced the fallback's shaFile writes and undercounted the lines). Wait for the gate tombstone
    // first (proves the op itself didn't wedge), then for the actual preconditions this block's own checks
    // below need — the forfeit event AND all 3 expected shaFile lines.
    const shaFileReady = () => fs.existsSync(shaFile) && fs.readFileSync(shaFile, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).length >= 3;
    const r = await sessions.mergeBatchTracked(mgrId, [wA, wB]);
    if (!r.settled) {
      await waitUntil(() => sessions.gateStatus(r.op.opId).state === "settled",
        { timeoutMs: 60_000, label: "batch op to settle asynchronously (missed the 12s sync-wait budget)" });
      await waitUntil(() => !!db.getLatestEventForManagerByKind(mgrId, "batch_merge_forfeited") && shaFileReady(),
        { timeoutMs: 60_000, label: "batch_merge_forfeited event + the fallback's own shaFile lines to land after the async-degraded op settled" });
    }
    check("(e2e, FORFEIT) card f944d4e4/bb2b3f29: settles — synchronously, or (if slow) via the documented async degrade — never left permanently pending",
      r.settled || sessions.gateStatus(r.op.opId).state === "settled");
    // `r.value` is only available on the sync fast path — same placeholder reasoning as the FAIL block
    // above: a genuine forfeit ALWAYS falls back regardless of timing, so `ok:false` here matches what the
    // real value would also have been, never a guess.
    const result = r.settled && r.ok ? r.value : { ok: false, landed: [], fallback: [], reason: "settled via the async degrade path, not the sync fast path" };
    check("(e2e, FORFEIT) ok:false — a genuine forfeit falls back, same top-level shape as a red gate", result.ok === false);

    check("(e2e, FORFEIT) precondition: the race gate command actually recorded an advanced sha", fs.existsSync(shaFile));
    // First line = the ORIGINAL batch gate's own race commit — the sha fastForwardCanonicalMain actually
    // observed. At least 2 more lines are expected below it (one per fallback re-gate of the 2 candidates).
    const shaLines = fs.existsSync(shaFile) ? fs.readFileSync(shaFile, "utf8").split("\n").map((l) => l.trim()).filter(Boolean) : [];
    check("(e2e, FORFEIT) precondition: the fallback also re-ran the race gate per candidate (>=3 total lines: 1 batch + 2 fallback)", shaLines.length >= 3);
    const advancedSha = shaLines[0];

    const forfeitEvent = db.getLatestEventForManagerByKind(mgrId, "batch_merge_forfeited");
    check("(e2e, FORFEIT) a batch_merge_forfeited event was actually filed", !!forfeitEvent);
    const detail = forfeitEvent?.detail ?? {};
    // THE DISCRIMINATING ASSERTION for this card: reverting sessions/service.ts's evtBatch call (or
    // batch-merge.ts's RunBatchedMergeResult/runBatchedMerge plumbing) back to dropping the value makes
    // this go undefined/missing while every other check in this block (the forfeit itself, the fallback,
    // the reason field which was ALREADY emitted before this card) stays green.
    check("(e2e, FORFEIT) detail.currentMainSha is present and equals the REAL advanced-to sha the gate command observed — not merely present",
      typeof detail.currentMainSha === "string" && !!advancedSha && detail.currentMainSha === advancedSha);
    check("(e2e, FORFEIT) detail.currentMainSha is NOT the stale baseMainSha it forfeited from", detail.currentMainSha !== detail.baseMainSha);
    check("(e2e, FORFEIT) detail.reason (pre-existing, now also documented by this card) is present", typeof detail.reason === "string" && detail.reason.length > 0);
    check("(e2e, FORFEIT) detail.currentMainSha is never the literal string \"undefined\"", detail.currentMainSha !== "undefined");
    // Card 6cc803b2: the forfeit check IS the fast-forward attempt (both happen inside the ONE
    // fastForwardCanonicalMain call — see RunBatchedMergeResult.fastForwardMs's own doc), so this is the
    // one path that exercises fastForwardMs on the batch_merge_forfeited event itself.
    check("(e2e, FORFEIT) card 6cc803b2: detail.fastForwardMs is a real (non-negative) number on the forfeit event", typeof detail.fastForwardMs === "number" && detail.fastForwardMs >= 0);
    // `result.phaseTimings` (the JS-return-value side of this cross-check) is only available on the sync
    // fast path — same availability caveat as the (e2e) PASS block above. detail.fastForwardMs (the DB
    // side, just asserted above) is unconditional either way.
    if (r.settled && r.ok) {
      check("(e2e, FORFEIT) card 6cc803b2: mergeBatch's own return value echoes the SAME fastForwardMs",
        typeof result.phaseTimings?.fastForwardMs === "number" && result.phaseTimings.fastForwardMs === detail.fastForwardMs);
    } else {
      console.log("(e2e, FORFEIT) NOTE: settled via the async degrade path — result.phaseTimings.fastForwardMs is not recoverable that way; skipping this one assertion. detail.fastForwardMs (the DB side) is still asserted above unconditionally.");
    }

    try { fs.rmSync(shaFile, { force: true }); } catch { /* best-effort scratch cleanup */ }
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
    // Card fd0d34da: the SAME `detail.batched === true` fallback, widened to the new coarse-WHY field —
    // stamped alongside a `notApplicable:true` verdict (never alongside a real true/false, mirroring the
    // producer's own mutual-exclusion guarantee — see `evtBatch("build_gate", ...)`'s own comment).
    const opNotApplicable = randomUUID();
    db.appendEvent({
      id: randomUUID(), ts: new Date(Date.now() - 500).toISOString(), managerSessionId: mgr, kind: "build_gate",
      detail: { opId: opNotApplicable, passed: true, batched: true, branchCount: 2, durationMs: 4321, gateCap: 2, concurrentGates: 1, concurrentGatesMax: 2, emitCompareNotApplicableKind: "path-out-of-scope" },
    });

    const page = db.listGateEvents({ projectId: P, limit: 50, offset: 0 });
    const decidedFalse = page.items.find((r) => r.opId === opDecidedFalse);
    const undecidable = page.items.find((r) => r.opId === opUndecidable);
    const solo = page.items.find((r) => r.opId === opSolo);
    const notApplicableRow = page.items.find((r) => r.opId === opNotApplicable);
    check("(unit) a batched row's DECIDABLE false is recovered from detail, not left null", decidedFalse?.emitCompareReduced === false);
    check("(unit) the SAME row's durationMs/gateCap/concurrentGates/concurrentGatesMax read back intact", decidedFalse?.durationMs === 12345 && decidedFalse?.gateCap === 2 && decidedFalse?.concurrentGates === 1 && decidedFalse?.concurrentGatesMax === 2);
    check("(unit) a batched row with NO emitCompareReduced in detail (undecidable) reads back null, never fabricated", undecidable?.emitCompareReduced === null);
    check("(unit) a non-batched row's own detail (no emitCompareReduced at all) reads back null, unaffected by this fallback", solo?.emitCompareReduced === null);
    check("(unit, card fd0d34da) a batched row's coarse WHY is recovered from detail via the SAME fallback", notApplicableRow?.emitCompareNotApplicableKind === "path-out-of-scope");
    check("(unit, card fd0d34da) that SAME row's emitCompareReduced stays null — a notApplicable verdict is never also a decided true/false", notApplicableRow?.emitCompareReduced === null);
    check("(unit, card fd0d34da — NEGATIVE CONTROL) a genuinely-decided false row carries NO coarse WHY (mutually exclusive by construction)", decidedFalse?.emitCompareNotApplicableKind === null);
    check("(unit, card fd0d34da — NEGATIVE CONTROL) a non-batched row's legacy detail (no such key at all) reads emitCompareNotApplicableKind:null, unaffected by this fallback", solo?.emitCompareNotApplicableKind === null);
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
