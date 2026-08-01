import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// gate_status/gate_queue IDLE TIME (the gap this file closes): `gate_status` returned {state, gateType,
// elapsedMs} and `gate_queue`'s entries carried {since, elapsedMs, ...} — NEITHER exposed how long a gate
// has been IDLE, even though idle time is the signal the daemon itself already uses to decide whether a
// gate is alive (gate-runner.ts's `runGateStep`: `if (canExtend && !extended && idleMs < GATE_EXTEND_IDLE_MS)
// { extend, don't kill }`). A long `elapsedMs` is frequently HEALTHY BY DESIGN (a gate still producing
// output gets its timeout extended rather than killed), so `elapsedMs` alone cannot answer "is this
// wedged?" — two Loom managers have independently eyed a healthy gate as "possibly wedged" purely because
// the only number on offer was the wrong one.
//
// THE FIX (mirrors `lastEngineOutputAt` on `worker_list` — an existing intra-turn liveness signal distinct
// from turn-boundary activity): `GateLivenessHooks` (gate-runner.ts) fire `onStepStart`/`onOutput`/
// `onExtend` from the REAL runner's own internal `lastOutputAt`/`extended` state — never a second,
// independently-computed clock — and `GateSemaphore`'s registry mirrors them onto each entry
// (`lastOutputAt`/`extended`). `gate_status`/`gate_queue` (SessionService.gateStatus/gateQueueForManager)
// read those raw fields and derive `idleMs`/`extended` at read time, the same way `elapsedMs` is already
// derived from `since`.
//
// Proves, per this project's standing verification posture (a check must be shown able to FAIL, with a
// positive control, before its green is trusted):
//   (1) (unit, deterministic) GateSemaphore's own hook wiring: `lastOutputAt`/`extended` on a LIVE
//       snapshot entry actually move in response to `onStepStart`/`onOutput`/`onExtend` calls — the field
//       is null while nothing has run, is stamped the instant a step starts (before any output), advances
//       forward on `onOutput`, and `extended` flips true on `onExtend` then resets false on the NEXT
//       `onStepStart` (per-step, not per-run). A broken/no-op wiring would leave these static — this is
//       the RED-first proof that they don't.
//   (2) (e2e, REAL spawn) a REAL runWorkerGate op's `idleMs` (read via BOTH `gate_queue` and `gate_status`)
//       grows monotonically while its child is genuinely quiet, and DROPS back down once the child
//       produces new output — polled via waitUntil (never a blind sleep guessing at timing), so a static
//       or always-null `idleMs` would time out and fail loudly rather than pass on a lucky guess.
//   (3) (e2e, REAL spawn, REAL auto-extend) `extended` reads `false` immediately after admission and
//       flips to `true` once the gate's OWN GATE_EXTEND_IDLE_MS-gated auto-extend genuinely fires (a
//       steadily-producing child that outlives the first deadline) — proving `extended` isn't a static
//       stub either, and that it reflects the SAME decision gate-runner.ts's own onTimeout makes.
//   (4) (e2e, cross-project) `idleMs`/`extended` are present (not omitted) on a FOREIGN project's
//       `gate_queue` entry — unlike `taskId`/`branch`/`workerLabel`, which stay omitted for a foreign
//       entry — proving idle/extend visibility was added WITHOUT widening what a foreign entry exposes.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/gate-idle-liveness.mjs

// LOOM_GATE_EXTEND_IDLE_MS must be set BEFORE gate-runner.js is ever imported (module-load-time constant).
// Same test-only dial-down as gate-timeout-extend.mjs, chosen for the SAME reason (see that file's header:
// small numbers drifted below real host scheduling jitter under load) — reusing its exact, already-tuned
// value here rather than picking a fresh one.
process.env.LOOM_GATE_EXTEND_IDLE_MS = "2000";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (p) => `"${p}"`; // quote a path for both cmd.exe and posix sh

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-gil-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { GateSemaphore } = await import("../dist/orchestration/gate-semaphore.js");

const GIT_ID = "-c user.email=gil@loom -c user.name=gil";
const now = new Date().toISOString();

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# gil\n");
  execSync(`git init -q && git config user.email gil@loom && git config user.name gil && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

function writeScript(scratchDir, name, body) {
  fs.mkdirSync(scratchDir, { recursive: true });
  const file = path.join(scratchDir, name);
  fs.writeFileSync(file, body);
  return `${q(process.execPath)} ${q(file)}`;
}

// ── (1) unit, deterministic: GateSemaphore's hook wiring actually moves lastOutputAt/extended ───────────
{
  const sem = new GateSemaphore();
  let capturedHooks;
  let release;
  const held = new Promise((res) => { release = res; });
  const p = sem.runExclusive(1, { gateType: "worker", projectId: "P", sessionId: "s1" }, async (_startedAt, _cancelSignal, hooks) => {
    capturedHooks = hooks;
    return held;
  });
  await sleep(20); // let admission + the fn's first microtask actually run (cap has headroom, so this is immediate)

  const before = sem.snapshot().entries[0];
  check("(1) precondition: the entry is running", before.phase === "running");
  check("(1) lastOutputAt is null before ANY hook fires — nothing has run yet", before.lastOutputAt === null);
  check("(1) extended is false before any hook fires", before.extended === false);

  capturedHooks.onStepStart();
  const afterStart = sem.snapshot().entries[0];
  check("(1) onStepStart stamps lastOutputAt to a real, non-null timestamp — BEFORE any output byte", typeof afterStart.lastOutputAt === "number");

  await sleep(60); // real, measurable gap — Date.now() resolution is ~1ms, 60ms leaves no ambiguity
  capturedHooks.onOutput();
  const afterOutput = sem.snapshot().entries[0];
  check("(1) THE RED-FIRST PROOF: onOutput advances lastOutputAt strictly forward — a static/broken wiring would leave this UNCHANGED", afterOutput.lastOutputAt > afterStart.lastOutputAt);

  check("(1) extended is STILL false — no extend has fired yet (negative control before the positive below)", sem.snapshot().entries[0].extended === false);
  capturedHooks.onExtend();
  check("(1) onExtend flips extended to true", sem.snapshot().entries[0].extended === true);
  capturedHooks.onStepStart(); // a fresh step starting (as gate-runner.ts does between sequential steps)
  check("(1) a FRESH onStepStart resets extended back to false — per-STEP state, not a whole-run total", sem.snapshot().entries[0].extended === false);

  release("done");
  await p;
  check("(1) the entry is gone from the live snapshot once settled (no leaked registry row)", sem.snapshot().entries.length === 0);
}

const dbs = [];
const worktrees = [];
const scratchDirs = [];
try {
  // ── (2) e2e, REAL spawn: idleMs grows while quiet, drops after new output — via gate_queue AND gate_status ──
  {
    const P = `gil-idle-${Date.now()}`;
    const repo = path.join(os.tmpdir(), `${P}-repo`);
    makeRepo(repo);
    const scratchDir = path.join(os.tmpdir(), `${P}-scratch`);
    scratchDirs.push(scratchDir);
    // tick-1 prints immediately; tick-2 prints 3s later (a real, generously-sized quiet gap); the process
    // then stays alive another 3s before exiting, giving a wide, reliably-pollable window AFTER tick-2 in
    // which idleMs must have already dropped back down — no fixed-sleep timing guess anywhere below,
    // every check below POLLS for the real state (see _wait.mjs's own doctrine: never widen a sleep,
        // remove the ambiguity instead).
    const gateCommand = writeScript(scratchDir, "quiet-then-tick.cjs", [
      'console.log("tick-1");',
      "setTimeout(() => {",
      '  console.log("tick-2");',
      "  setTimeout(() => process.exit(0), 3000);",
      "}, 3000);",
    ].join("\n"));
    const db = new Db();
    dbs.push(db);
    db.insertProject({ id: P, name: "GIL Idle", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand, gateCommandTimeoutMs: 60_000 } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: "gil-a1", projectId: P, name: "dev-1", startupPrompt: "", position: 0 });
    const taskId = `${P}-task`, workerId = `${P}-wkr`;
    db.insertTask({ id: taskId, projectId: P, title: "GIL idle task", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath, branch } = await createWorktree(repo, P, taskId);
    worktrees.push(worktreePath);
    db.insertSession({ id: workerId, projectId: P, agentId: "gil-a1", engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId, worktreePath, branch });

    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    // NO injected `runGate` — this is the REAL runGateSequential/runGateStep pipeline, so idleMs reflects
    // ACTUAL child-process liveness, not a test double standing in for it. GENEROUS syncAttachBudgetMs
    // (card e082bf4d): this script's own real ~6s runtime leaves only a 2x margin against the production
    // SYNC_ATTACH_BUDGET_MS default (12s) — under host contention the real op can legitimately exceed it
    // with nothing wrong, and `result?.settled === true` below wants the SYNCHRONOUS-settle shape, not a
    // host-speed race. Widening here is test-only; the live-polling assertions above read `gateQueueForManager`/
    // `gateStatus` directly and are unaffected either way.
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000 });

    const p1 = sessions.runWorkerGate(workerId).catch((e) => { console.error("gil idle run rejected:", e); });
    await waitUntil(() => sessions.gateQueueForManager(P).activeCount === 1, { label: "(2) gate genuinely admitted" });

    const running0 = sessions.gateQueueForManager(P).running[0];
    check("(2) precondition: opId is present on the running entry (chainable into gate_status)", typeof running0.opId === "string" && running0.opId.length > 0);
    const opId = running0.opId;

    // `run_gate` has a real pre-flight git-stamp read AFTER admission but BEFORE its own runGateSequential
    // call (see GateSnapshotEntry.lastOutputAt's doc) — so idleMs can genuinely still read null for a brief
    // real window right after admission. Poll (never a fixed-sleep guess) for it to become non-null, which
    // itself proves the step actually started and the hook wiring stamped it.
    const started = await waitUntil(
      () => { const r = sessions.gateQueueForManager(P).running[0]; return r && r.idleMs != null ? r : undefined; },
      { label: "(2) idleMs becomes non-null once the step genuinely starts (past run_gate's pre-flight gap)" },
    );
    check("(2) idleMs is a real number once the step has started", typeof started.idleMs === "number");
    const gsRunning0 = sessions.gateStatus(opId);
    check("(2) gate_status reports the SAME idleMs shape as gate_queue for the SAME live op", gsRunning0.state === "running" && typeof gsRunning0.idleMs === "number");

    // THE GROWTH PROOF: poll until idleMs has grown well past the admission-time reading — a static/broken
    // idleMs (always 0, always the same value, or always null) would time out here instead of passing.
    const GROWTH_FLOOR_MS = 1500; // comfortably inside the 3000ms quiet gap, comfortably above admission noise
    const grown = await waitUntil(
      () => { const r = sessions.gateQueueForManager(P).running[0]; return r && r.idleMs > GROWTH_FLOOR_MS ? r : undefined; },
      { timeoutMs: 8000, label: `(2) idleMs grows past ${GROWTH_FLOOR_MS}ms while the child stays quiet (RED-first: a static/broken idleMs times out here)` },
    );
    check("(2) idleMs genuinely grew past the floor while quiet", grown.idleMs > GROWTH_FLOOR_MS);
    check("(2) gate_status agrees with gate_queue's grown reading (both derive from the SAME registry entry)", sessions.gateStatus(opId).idleMs > GROWTH_FLOOR_MS);

    // THE RESET PROOF: after tick-2 prints (~3000ms mark) and BEFORE the process exits (~6000ms mark),
    // idleMs must drop back down — proving the clock responds to NEW output, not just monotonic growth.
    const RESET_CEILING_MS = 1200; // must have reset well below where growth was tolerated above
    const reset = await waitUntil(
      () => { const r = sessions.gateQueueForManager(P).running[0]; return r && r.idleMs < RESET_CEILING_MS ? r : undefined; },
      { timeoutMs: 8000, label: `(2) idleMs drops back under ${RESET_CEILING_MS}ms after tick-2's new output (the field must MOVE IN BOTH DIRECTIONS, not just grow)` },
    );
    check("(2) idleMs genuinely reset after new output — producing output vs. quiet yield DIFFERENT values, in both directions", reset.idleMs < RESET_CEILING_MS);

    const result = await p1;
    check("(2) the real gate eventually settles passed:true (the script's own clean exit 0)", result?.settled === true && result.ok === true && result.value.passed === true);
    check("(2) once settled, gate_status no longer reports a live idleMs (falls back to the tombstone, idleMs:null)", sessions.gateStatus(opId).idleMs === null && sessions.gateStatus(opId).state === "settled");
  }

  // ── (3) e2e, REAL spawn, REAL auto-extend: extended flips false → true ───────────────────────────────
  {
    const P = `gil-extend-${Date.now()}`;
    const repo = path.join(os.tmpdir(), `${P}-repo`);
    makeRepo(repo);
    const scratchDir = path.join(os.tmpdir(), `${P}-scratch`);
    scratchDirs.push(scratchDir);
    // Steady output every 150ms, forever — same "streaming-forever" shape as gate-timeout-extend.mjs's own
    // fixture (C): idle at the first deadline is tiny (≈150ms), so the REAL auto-extend fires.
    const gateCommand = writeScript(scratchDir, "streaming-forever.cjs", 'setInterval(() => { console.log("tick"); }, 150);');
    const TIMEOUT_MS = 3000; // same proven-under-load constant as gate-timeout-extend.mjs (paired with LOOM_GATE_EXTEND_IDLE_MS=2000 above)
    const db = new Db();
    dbs.push(db);
    db.insertProject({ id: P, name: "GIL Extend", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand, gateCommandTimeoutMs: TIMEOUT_MS } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: "gil-a2", projectId: P, name: "dev-2", startupPrompt: "", position: 0 });
    const taskId = `${P}-task`, workerId = `${P}-wkr`;
    db.insertTask({ id: taskId, projectId: P, title: "GIL extend task", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath, branch } = await createWorktree(repo, P, taskId);
    worktrees.push(worktreePath);
    db.insertSession({ id: workerId, projectId: P, agentId: "gil-a2", engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId, worktreePath, branch });

    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    // GENEROUS syncAttachBudgetMs (card e082bf4d): this run takes ~2×TIMEOUT_MS (~6s) real wall-clock
    // before its final settle at line 251 — under host contention that can legitimately exceed the
    // production SYNC_ATTACH_BUDGET_MS default (12s) with nothing wrong. Widening here is test-only; the
    // live-polling assertions above read `gateQueueForManager`/`gateStatus` directly and are unaffected.
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000 });

    const p1 = sessions.runWorkerGate(workerId).catch((e) => { console.error("gil extend run rejected:", e); });
    await waitUntil(() => sessions.gateQueueForManager(P).activeCount === 1, { label: "(3) gate genuinely admitted" });

    const opId = sessions.gateQueueForManager(P).running[0].opId;
    check("(3) NEGATIVE CONTROL: extended reads false immediately after admission (well before the first deadline)", sessions.gateQueueForManager(P).running[0].extended === false);
    check("(3) gate_status agrees: extended:false pre-deadline", sessions.gateStatus(opId).extended === false);

    // THE POSITIVE PROOF: poll (never a fixed-sleep guess) until extended flips true — this only happens
    // if gate-runner.ts's REAL onTimeout decided to extend, which only happens once the first deadline
    // (TIMEOUT_MS) actually fires. Bound generously past the worst-case scheduling jitter this project's
    // own gate-timeout-extend.mjs documented (up to ~1.6s delay under heavy contention) and comfortably
    // before the second (killing) deadline at ~2×TIMEOUT_MS.
    const extended = await waitUntil(
      () => { const r = sessions.gateQueueForManager(P).running[0]; return r && r.extended === true ? r : undefined; },
      { timeoutMs: TIMEOUT_MS * 1.8, label: "(3) extended flips to true once the REAL auto-extend fires at the first deadline" },
    );
    check("(3) extended genuinely flipped true — the run's own gate-runner.ts decision, not a stub", extended.extended === true);
    // GateQueueEntry has no `phase` field — membership in `.running` (which the waitUntil predicate above
    // already required to find `extended`) IS the "still running, not settled" proof; double-check via a
    // fresh read too.
    check("(3) still reported as running while in the extended (second) window, not settled early", sessions.gateQueueForManager(P).activeCount === 1 && sessions.gateQueueForManager(P).running[0]?.opId === opId);
    check("(3) gate_status agrees with gate_queue on extended:true", sessions.gateStatus(opId).extended === true);

    // Let it run to its natural (killed-at-the-second-deadline) conclusion, same shape gate-timeout-extend.mjs
    // proves at the runGateStep layer — here just confirming the FULL runWorkerGate pipeline settles sanely
    // once extended, rather than leaving a dangling process/promise behind.
    const result = await p1;
    check("(3) eventually settles as a genuine timeout (killed at the SECOND deadline, after the one extension)", result?.settled === true && result.ok === true && result.value.passed === false && result.value.gateDetail?.timedOut === true);
  }

  // ── (4) e2e, cross-project: idleMs/extended are present on a FOREIGN entry (not redacted-to-omitted) ──
  {
    const P1 = `gil-own-${Date.now()}`, P2 = `gil-foreign-${Date.now()}`;
    const repo1 = path.join(os.tmpdir(), `${P1}-repo`), repo2 = path.join(os.tmpdir(), `${P2}-repo`);
    makeRepo(repo1);
    makeRepo(repo2);
    const scratchDir = path.join(os.tmpdir(), `${P1}-scratch`);
    scratchDirs.push(scratchDir);
    // A single, real, slow-ish gate on P1 (cap 1) so P2's op is genuinely queued behind it while we read.
    const gateCommand = writeScript(scratchDir, "slow-pass.cjs", [
      'console.log("tick-1");',
      "setTimeout(() => process.exit(0), 2000);",
    ].join("\n"));
    const db = new Db();
    dbs.push(db);
    db.insertProject({ id: P1, name: "GIL Own", repoPath: repo1, vaultPath: repo1, config: { orchestration: { gateCommand, gateCommandTimeoutMs: 30_000 } }, createdAt: now, archivedAt: null });
    db.insertProject({ id: P2, name: "GIL Foreign", repoPath: repo2, vaultPath: repo2, config: { orchestration: { gateCommand, gateCommandTimeoutMs: 30_000 } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: "gil-b1", projectId: P1, name: "dev-1", startupPrompt: "", position: 0 });
    db.insertAgent({ id: "gil-b2", projectId: P2, name: "dev-2", startupPrompt: "", position: 0 });
    const t1 = `${P1}-task`, t2 = `${P2}-task`;
    db.insertTask({ id: t1, projectId: P1, title: "GIL own task", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertTask({ id: t2, projectId: P2, title: "GIL foreign task — must never leak", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const wt1 = await createWorktree(repo1, P1, t1);
    const wt2 = await createWorktree(repo2, P2, t2);
    worktrees.push(wt1.worktreePath, wt2.worktreePath);
    const w1 = `${P1}-wkr`, w2 = `${P2}-wkr`;
    db.insertSession({ id: w1, projectId: P1, agentId: "gil-b1", engineSessionId: null, title: null, cwd: wt1.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId: t1, worktreePath: wt1.worktreePath, branch: wt1.branch });
    db.insertSession({ id: w2, projectId: P2, agentId: "gil-b2", engineSessionId: null, title: null, cwd: wt2.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId: t2, worktreePath: wt2.worktreePath, branch: wt2.branch });

    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

    const p1 = sessions.runWorkerGate(w1).catch((e) => { console.error("gil own run rejected:", e); });
    await waitUntil(() => sessions.gateQueueForManager(P1).activeCount === 1, { label: "(4) w1 admitted" });
    const p2 = sessions.runWorkerGate(w2).catch((e) => { console.error("gil foreign run rejected:", e); });
    await waitUntil(() => sessions.gateQueueForManager(P1).queuedCount === 1, { label: "(4) w2 registered as queued behind w1" });

    const own = sessions.gateQueueForManager(P1);
    const ownRunning = own.running[0];
    const foreignQueued = own.queued[0];
    check("(4) precondition: P1's own entry is running, P2's is queued", ownRunning.projectId === P1 && foreignQueued.projectId === P2);
    check("(4) OWN-project running entry: idleMs is a real number (not omitted, not null)", typeof ownRunning.idleMs === "number");
    check("(4) OWN-project running entry: extended is present (boolean)", typeof ownRunning.extended === "boolean");
    check("(4) FOREIGN (queued) entry OMITS taskId/branch/workerLabel — the existing redaction, unaffected by this change", !("taskId" in foreignQueued) && !("branch" in foreignQueued) && !("workerLabel" in foreignQueued));
    check("(4) THE POINT OF THIS CHECK: the FOREIGN entry does NOT omit idleMs — it's present (null, since queued — not yet running) exactly like an own-project queued entry would be", "idleMs" in foreignQueued && foreignQueued.idleMs === null);
    check("(4) THE FOREIGN entry does NOT omit extended either — present (false, since queued)", "extended" in foreignQueued && foreignQueued.extended === false);
    check("(4) the foreign task's title never appears anywhere in the snapshot (idleMs/extended didn't smuggle anything else along)", !JSON.stringify(own).includes("GIL foreign task"));

    // Flip perspective: from P2's own view, P1's running entry is redacted (existing behavior) but STILL
    // carries a real, live idleMs — proving the exposure is symmetric, not an accidental one-way leak.
    const foreign = sessions.gateQueueForManager(P2);
    const p1RunningFromP2 = foreign.running[0];
    check("(4) from P2's view, P1's running entry is STILL redacted (taskId/branch omitted)", !("taskId" in p1RunningFromP2) && !("branch" in p1RunningFromP2));
    check("(4) from P2's view, P1's running entry STILL carries a real idleMs (not omitted for a foreign caller)", typeof p1RunningFromP2.idleMs === "number");

    await p1;
    await p2;
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
  for (const dir of scratchDirs) try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — GateSemaphore's GateLivenessHooks wiring (onStepStart/onOutput/onExtend) demonstrably moves lastOutputAt/extended on a live snapshot entry (RED-first: a static/broken wiring would leave these unchanged, and the negative/reset controls would time out rather than pass); a REAL runWorkerGate op's idleMs (read via BOTH gate_queue and gate_status) grows monotonically while its child is genuinely quiet and drops back down after new output — producing output vs. going quiet yield DIFFERENT values, in both directions, polled rather than guessed; extended reads false pre-deadline and flips true only once gate-runner.ts's OWN GATE_EXTEND_IDLE_MS-gated auto-extend genuinely fires; and idleMs/extended are present (never omitted) on a cross-project gate_queue entry exactly where taskId/branch/workerLabel remain redacted, proving the new fields didn't widen what a foreign project's entry exposes."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
