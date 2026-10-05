import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// MERGE-BATCH DEDUPE/ATTACH (card f944d4e4, `SessionService.mergeBatchTracked`) — proves the DoD-3
// polarity the card itself calls out: "a broken attach returns a plausible-looking {pending} exactly
// like a working one" — so a test asserting only the RESPONSE SHAPE verifies nothing. This asserts the
// thing that actually matters: a SECOND `mergeBatchTracked` call for the SAME resolved candidate set,
// fired WHILE the first is still running, starts NO NEW WORK — no second worktree cut, no second real
// gate run, no second `pending_gate_ops` tombstone minted.
//
// THE PROOF (not just the assertion): `insertPendingGateOp` (sessions/service.ts, inside `runGate`'s
// closure) fires exactly once per REAL `run()` invocation — it is minted immediately before gate
// admission, on the SAME code path that cuts the batch worktree just above it. So counting
// `pending_gate_ops` rows for this project after both calls settle is a direct, causally-tied proxy for
// "how many times did the expensive body actually execute" — if attach() worked, exactly 1; if it merely
// looked like it worked (a broken key, a key computed too late, an attach() call that races run() twice),
// 2. This is the SAME reasoning the card's own DoD-3 names `onOpMinted` as a clean observation point for
// (pending-ops.ts) — this test uses the durable DB row instead, since mergeBatchTracked deliberately opts
// OUT of attach()'s `onOpMinted` hook (see its own header doc — no extra finalize logic) and mints its
// OWN tombstone directly inside `run()`.
//
// RED PROOF (done by hand during development, not re-run here — see the card's own worker_report for the
// transcript): with `packages/daemon/src/sessions/service.ts` reverted to pre-card-f944d4e4 HEAD (bare
// `mergeBatch`, no attach()) and this test's `mergeBatchTracked` call swapped for the old `mergeBatch`
// name, firing two concurrent calls produces `pending_gate_ops` COUNT 2 for this project, not 1 — the
// exact failure this test is built to catch. Restoring the fixed source + this test's real call makes it
// pass again. Not re-executed on every run because it requires literally reverting the source under test,
// which this file cannot safely do to itself mid-suite.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-batch-dedupe.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mbd-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=mbd@loom -c user.name=mbd";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# mbd\n");
  execSync(`git init -q && git config user.email mbd@loom && git config user.name mbd`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

async function cutBranch(repo, projId, label, file, content) {
  const taskId = `mbd-task-${label}-${sfx}`;
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, file), content);
  commitAll(worktreePath, `${label}`, GIT_ID);
  return { taskId, branch, worktreePath };
}

const dbs = [];
const worktrees = [];
try {
  const repo = path.join(os.tmpdir(), `loom-mbd-${sfx}`);
  makeRepo(repo);
  const projId = `mbd-proj-${sfx}`;
  const agentId = `mbd-agent-${sfx}`;
  const mgrId = `mbd-mgr-${sfx}`;

  const db = new Db(); dbs.push(db);
  db.insertProject({ id: projId, name: "MBD", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const a = await cutBranch(repo, projId, "a", "feature-a.txt", "work a\n");
  const b = await cutBranch(repo, projId, "b", "feature-b.txt", "work b\n");
  worktrees.push(a.worktreePath, b.worktreePath);
  const wA = `mbd-wkr-a-${sfx}`, wB = `mbd-wkr-b-${sfx}`;
  for (const [wId, w, label] of [[wA, a, "a"], [wB, b, "b"]]) {
    db.insertTask({ id: w.taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: wId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch });
  }

  // Card 9f341f6f: the OLD precondition fired the real 2s-sleep subprocess above and then polled
  // `gateSemaphore.snapshot()` within a FIXED 20s window to detect "the first call is genuinely in
  // flight" — but everything AHEAD of admission (candidate resolution, real git `resolveGitRef` head
  // reads, the mainline-watermark read) is genuine async git I/O that can legitimately outlast a fixed
  // window under host contention (a concurrent gate elsewhere), flipping this precondition RED for a
  // reason that has nothing to do with the dedupe behavior under test (reproduced: shrinking the window
  // to 1ms reliably reproduces the exact FAIL the gate saw). Replaced with a CONTROLLABLE SEAM instead of
  // a race: `runGate` is injected as a deferred the test itself holds open, so "the first call's gate
  // request is genuinely in flight" becomes an observed EVENT (the seam was entered), never a timing
  // guess — and the first call stays provably in flight for as long as the test wants, independent of
  // host speed.
  let releaseGate;
  const gateHeld = new Promise((resolve) => { releaseGate = resolve; });
  let gateEnteredResolve;
  const gateEntered = new Promise((resolve) => { gateEnteredResolve = resolve; });
  let gateCalls = 0;
  const controllableGate = async () => {
    gateCalls++;
    gateEnteredResolve();
    await gateHeld;
    return { passed: true };
  };
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: controllableGate });

  // Fire the first call — do NOT await yet.
  const p1 = sessions.mergeBatchTracked(mgrId, [wA, wB]);

  // Wait for the DETERMINISTIC signal that the first call's gate request was genuinely admitted and is
  // now running — never a fixed-window race. Bounded generously (60s) so a genuine wedge (attach never
  // reaching the gate at all) still fails loudly instead of hanging forever.
  let enteredInTime = true;
  await Promise.race([
    gateEntered,
    new Promise((resolve) => setTimeout(() => { enteredInTime = false; resolve(); }, 60_000)),
  ]);
  check("precondition: the first call's gate request is genuinely in flight (admitted into the gate semaphore and running — confirmed via the controllable gate seam, not a timing race)", enteredInTime && gateCalls === 1);

  // Fire the SECOND call — SAME workerSessionIds, so the SAME resolved candidate set, so the SAME
  // dedupe/attach key — while the first is PROVABLY still running (held open by the test, never raced).
  const p2 = sessions.mergeBatchTracked(mgrId, [wA, wB]);

  // Now let both calls actually settle.
  releaseGate();

  // Card 58f80a64: under host contention either call can legitimately degrade to `{settled:false}` (the real-git
  // batch outruns SYNC_ATTACH_BUDGET_MS). Re-calling with the SAME ids re-attaches to the same in-flight op via the
  // dedupe key (never a re-run), so re-poll until settled — bounded, throwing loudly on a real wedge.
  const settleBatch = async (r) => {
    const deadline = Date.now() + 60_000;
    while (!r.settled) {
      if (Date.now() > deadline) throw new Error(`mergeBatchTracked did not settle within 60s (last op state: ${JSON.stringify(r.op)})`);
      r = await sessions.mergeBatchTracked(mgrId, [wA, wB]);
    }
    return r;
  };
  const [r1, r2] = await Promise.all([p1.then(settleBatch), p2.then(settleBatch)]);

  check("(1) first call ends settled ok (after re-polling past any sync-wait degrade)", r1.settled === true && r1.ok === true);
  check("(2) second call ends settled ok too (after re-polling; attached to the same in-flight op)", r2.settled === true && r2.ok === true);
  check("(3) both calls report the batch landed", r1.settled && r1.ok && r1.value.ok === true && r2.settled && r2.ok && r2.value.ok === true);
  check("(4) both calls report the SAME two branches landed (not two independent runs each landing its own copy)",
    r1.settled && r1.ok && r2.settled && r2.ok &&
    r1.value.landed.length === 2 && r2.value.landed.length === 2 &&
    JSON.stringify(r1.value.landed.map((l) => l.sha).sort()) === JSON.stringify(r2.value.landed.map((l) => l.sha).sort()));

  // ── THE DISCRIMINATING ASSERTION (DoD-3) ──────────────────────────────────────────────────────────────
  // Both calls returning a plausible, matching result is EXACTLY what a broken attach (one that raced two
  // independent run()s to the SAME git state) would ALSO produce, since the batch always lands the same
  // two branches either way — the card's own warning that response-shape parity proves nothing. The real
  // discriminator is how many times the expensive body actually ran.
  const mergeOpsForProject = db.listPendingGateOps().filter((op) => op.projectId === projId && op.kind === "merge");
  check("(5) DoD-3: exactly ONE pending_gate_ops row was minted for this project — the second call started NO NEW WORK (no second worktree cut, no second real gate run)",
    mergeOpsForProject.length === 1);
  check("(5b) that one row is already settled (both callers' waits observed the same real op resolve)", mergeOpsForProject[0]?.state === "settled");
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
