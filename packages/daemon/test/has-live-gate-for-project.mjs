import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5eace211 (Code Review MINOR 5d) — `SessionService.hasLiveGateForProject` directly, against a REAL
// `GateSemaphore` (not a stub), proving it actually reads BOTH live sources it documents: an admitted-or-
// queued registry entry (`snapshot().entries`), and a merge-kind op that already released its cap slot but
// is still mid-squash (`squashOnlySnapshot()`, via `holdRepoGuardOnExit`). This is the permanent-delete
// route's own precondition check (`gateway/server.ts`'s `DELETE /api/projects/:id/permanent`) — the REST-
// level test (mgmt-project-agent.mjs section G) proves the ROUTE respects a controllable fake; this file
// proves the real method itself, scoped correctly per-project, across every state the semaphore can hold.
//
// Mirrors gate-semaphore-concurrency.mjs's own "Pure unit check" + "(squash-visibility)" shapes — same
// descriptor conventions, same holder/release pattern — but calls `SessionService.hasLiveGateForProject`
// on top, rather than asserting on `snapshot()`/`squashOnlySnapshot()` directly.
//
// Proves:
//   (1) no entries at all ⇒ false for any project.
//   (2) ONE RUNNING entry for project P ⇒ true for P, false for an unrelated project Q (scoped, not global).
//   (3) a cap-1 QUEUED entry for project Q (queued behind P's still-running hold) ⇒ true for Q too — a
//       queued-but-not-yet-admitted op still counts as "live" for this check.
//   (4) once BOTH settle (the holder released, the queued one completes) ⇒ false for both again — no leak.
//   (5) the squash-only gap this check was written to close: a merge gate that calls `holdRepoGuardOnExit`
//       releases its cap slot on settle (gone from `snapshot()`) but is still mid-squash — `true` for its
//       project throughout that window, `false` again only once `endSquash` actually fires.
//
// Run: 1) build (turbo builds shared first), 2) node test/has-live-gate-for-project.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-hlgfp-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const db = new Db();
const ptyStub = {};
const svc = new SessionService(db, ptyStub, new OrchestrationControl());

try {
  // ===================== (1) no entries at all =====================
  check("(1) no entries ⇒ hasLiveGateForProject is false for ANY project", svc.hasLiveGateForProject("proj-none") === false);

  // ===================== (2) ONE RUNNING entry, scoped correctly =====================
  // The resolver is captured SYNCHRONOUSLY, right here, rather than lazily inside the `fn` callback —
  // `fn` itself is only invoked once `acquire()`'s own internal `await` resolves (a microtask later), so
  // capturing it lazily would leave `releaseP` undefined for everything this file does before its next
  // `await`. Capturing it up front removes that ordering dependency entirely.
  let releaseP;
  const heldP = new Promise((resolve) => { releaseP = () => resolve("p-done"); });
  const pRun = svc.gateSemaphore.runExclusive(
    1,
    { gateType: "worker", projectId: "P", sessionId: "sess-p", taskId: "task-p", branch: "loom/p" },
    () => heldP,
  );
  // NO sleep here, deliberately (mirrors gate-semaphore-concurrency.mjs's own "(unit, cap 1)" precedent,
  // same file's comment on it): `runExclusive` registers its entry into the registry and runs `acquire()`'s
  // synchronous fast path (a free cap admits immediately) BEFORE it ever reaches its own first internal
  // `await` — nothing async happens between calling it here (not yet awaited) and the checks below.
  check("(2) a RUNNING entry for project P ⇒ true for P", svc.hasLiveGateForProject("P") === true);
  const qAbsentWhileOnlyPRuns = svc.hasLiveGateForProject("Q");
  check("(2) the SAME running state: project Q (nothing has EVER been scheduled against it) is unaffected — scoped, not a global flag", qAbsentWhileOnlyPRuns === false);

  // ===================== (3) a cap-1 QUEUED entry for Q, behind P's still-running hold =====================
  const pQueued = svc.gateSemaphore.runExclusive(
    1,
    { gateType: "merge", projectId: "Q", sessionId: "sess-q", taskId: "task-q", branch: "loom/q" },
    async () => "q-done",
  );
  // Same reasoning as above: enqueueing behind a full cap is ALSO part of `acquire()`'s synchronous body
  // (pushing a waiter), so Q's entry is already visible, queued, before this line runs — no sleep needed.
  const snapMidFlight = svc.gateSemaphore.snapshot();
  const qEntry = snapMidFlight.entries.find((e) => e.projectId === "Q");
  check("(3) precondition — Q has exactly one entry, in phase 'queued' (cap 1, P still holds the only slot)",
    snapMidFlight.active === 1 && snapMidFlight.queued === 1 && qEntry?.phase === "queued");
  const qLiveWhileQueued = svc.hasLiveGateForProject("Q");
  check("(3) a merely-queued (not yet admitted) entry for Q also counts as live — queued still counts", qLiveWhileQueued === true);
  const pStillLiveAlongsideQ = svc.hasLiveGateForProject("P");
  check("(3) P's own live state is unaffected by Q's arrival", pStillLiveAlongsideQ === true);

  // ===================== (4) release P ⇒ Q is admitted ⇒ both settle ⇒ both false again =====================
  releaseP();
  const [pResult, qResult] = await Promise.all([pRun, pQueued]);
  check("(4) both settle cleanly", pResult === "p-done" && qResult === "q-done");
  check("(4) registry is EMPTY after both settle (no leaked holder)", svc.gateSemaphore.snapshot().entries.length === 0);
  check("(4) hasLiveGateForProject is false for P again (no leak)", svc.hasLiveGateForProject("P") === false);
  check("(4) hasLiveGateForProject is false for Q again (no leak)", svc.hasLiveGateForProject("Q") === false);

  // ===================== (5) squash-only holder — the gap this check exists to narrow =====================
  // A passing merge gate that calls `holdRepoGuardOnExit` releases its CAP SLOT the instant its own `fn`
  // resolves (gone from `snapshot()`), but the repo guard — and this project's own "a gate is still live"
  // status — survives until `endSquash` explicitly frees it. Without consulting `squashOnlySnapshot()`
  // too, this exact window would read as "no gate running" while a real squash is still writing to the
  // project's shared work dir.
  const squashOpId = "squash-op-R";
  const gateResult = await svc.gateSemaphore.runExclusive(
    1,
    { gateType: "merge", projectId: "R", sessionId: "sess-r", taskId: "task-r", branch: "loom/r", repoPath: "/repo/R", opId: squashOpId },
    async (_startedAt, _cancelSignal, _hooks, _getMax, holdRepoGuardOnExit) => {
      holdRepoGuardOnExit(); // real confirmWorkerMerge shape: the repo hold survives the gate's own settle
      return "gate-done";
    },
  );
  check("(5) the gate itself settled normally", gateResult === "gate-done");
  check("(5) precondition — GONE from snapshot() the instant the gate settles (the pre-existing behavior)", svc.gateSemaphore.snapshot().entries.length === 0);
  check("(5) THE FIX: hasLiveGateForProject is STILL true for R while its squash is in flight (snapshot() alone would miss this)", svc.hasLiveGateForProject("R") === true);
  check("(5) an unrelated project is unaffected by R's squash hold", svc.hasLiveGateForProject("unrelated-project") === false);

  svc.gateSemaphore.endSquash("/repo/R", squashOpId);
  check("(5) once endSquash fires, hasLiveGateForProject is false again for R", svc.hasLiveGateForProject("R") === false);
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — SessionService.hasLiveGateForProject, against a REAL GateSemaphore: false with no entries, true while RUNNING, true while merely QUEUED behind a full cap, false again once both settle (no leak), and — the squash-only gap this check exists to narrow — still true for a merge's project while it's mid-squash past its own gate settle, false again only once endSquash fires. Scoped correctly throughout: an unrelated project never reads true."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
