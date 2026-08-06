import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Host-load guard test (card 301d8c01): proves the daemon-global GateSemaphore actually BOUNDS
// concurrent daemon-executed heavy gate runs (confirmWorkerMerge), not just that the code compiles.
//
// THE HOLE IT GUARDS: before this, N concurrent worker_merge_confirm calls could each spawn a heavy
// build/test command (runGateSequential) with zero coordination — only manager discipline (sequencing
// merges by hand) kept a self-hosting host from being starved by its own daemon. The incident that
// reopened this card was a single worker's OWN gate run starving a live sibling service; this guard
// targets the OTHER half of the card's framing — concurrent DAEMON-run gates.
//
// Proves, with an INJECTED `runGate` seam (no real spawn — a fake gate that sleeps a bit so two
// concurrent confirms have a wide window to actually overlap if nothing is bounding them):
//   (A) default cap (1, no platform override) SERIALIZES two concurrent confirmWorkerMerge calls on
//       the same daemon — the fake gate NEVER observes more than 1 concurrent invocation.
//   (B) raising the cap to 2 (via db.setPlatformConfig) lets both run TRULY concurrently — the fake
//       gate DOES observe 2 concurrent invocations (proving the guard isn't just an accidental full
//       serialization; it holds the config'd cap, not a hardcoded 1).
//   (C) a queued call still completes (no deadlock) and composes with the existing merge pipeline.
// Also a pure unit check of GateSemaphore.runExclusive in isolation, independent of the wiring above.
//
// Run: 1) build daemon (pnpm build), 2) node test/gate-semaphore-concurrency.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { assertNeverWithControl, observeOnce } from "./_timing-guard.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-gs-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { GateSemaphore, GateCancelledError } = await import("../dist/orchestration/gate-semaphore.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GIT_ID = "-c user.email=gs@loom -c user.name=gs";
const now = new Date().toISOString();

const dbs = [];
const worktrees = [];

// ── Pure unit check: GateSemaphore.runExclusive + its live registry in isolation ───────────────────
// runExclusive now takes a REQUIRED descriptor (card a1c86452) so the Gates page can enumerate live
// runs; these checks prove the counting/blocking path is unchanged AND that the registry entry is
// added/removed across every exit path — success, throw (a reject/timeout looks identical to the
// semaphore), and a queued entry's admission — so a leaked "phantom active gate" can never accumulate.
{
  const sem = new GateSemaphore();
  const desc = (id, gateType = "worker") => ({ gateType, projectId: `proj-${id}`, sessionId: `sess-${id}` });
  let active = 0, maxActive = 0;
  const task = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await sleep(80);
    active--;
    return "ok";
  };
  const results = await Promise.all([
    sem.runExclusive(1, desc(1), task),
    sem.runExclusive(1, desc(2), task),
    sem.runExclusive(1, desc(3), task),
  ]);
  check("(unit, cap 1) three tasks all resolve", results.every((r) => r === "ok"));
  check("(unit, cap 1) never more than 1 concurrent", maxActive === 1);
  check("(unit, registry) EMPTY after all runs settle (no leaked holder)",
    sem.snapshot().active === 0 && sem.snapshot().queued === 0 && sem.snapshot().entries.length === 0);

  active = 0; maxActive = 0;
  const results2 = await Promise.all([
    sem.runExclusive(2, desc(4), task),
    sem.runExclusive(2, desc(5), task),
  ]);
  check("(unit, cap 2) both resolve", results2.every((r) => r === "ok"));
  check("(unit, cap 2) reaches 2 concurrent (cap isn't a silent hardcoded 1)", maxActive === 2);

  // Snapshot mid-flight: one RUNNING (holding the lane) + one QUEUED (waiting), with descriptor + phase.
  {
    const sem2 = new GateSemaphore();
    let releaseHolder;
    const holder = () => new Promise((res) => { releaseHolder = res; }); // holds the single lane until released
    const pRun = sem2.runExclusive(1, { gateType: "merge", projectId: "P", sessionId: "s1", taskId: "t1", branch: "loom/aaa" }, () => holder());
    const pQueued = sem2.runExclusive(1, { gateType: "worker", projectId: "Q", sessionId: "s2", taskId: "t2", branch: "loom/bbb" }, async () => "second");
    await sleep(20); // let pRun acquire the lane + pQueued queue behind it
    const snap = sem2.snapshot();
    const runningEntry = snap.entries.find((e) => e.phase === "running");
    const queuedEntry = snap.entries.find((e) => e.phase === "queued");
    check("(unit, snapshot) reports exactly 1 active + 1 queued", snap.active === 1 && snap.queued === 1 && snap.entries.length === 2);
    check("(unit, snapshot) running entry carries its full descriptor",
      !!runningEntry && runningEntry.gateType === "merge" && runningEntry.projectId === "P" && runningEntry.branch === "loom/aaa" && typeof runningEntry.since === "number");
    check("(unit, snapshot) queued entry is phase=queued with queuePosition 1",
      !!queuedEntry && queuedEntry.phase === "queued" && queuedEntry.queuePosition === 1 && queuedEntry.gateType === "worker");
    releaseHolder("first");
    await Promise.all([pRun, pQueued]);
    check("(unit, snapshot) registry EMPTY after both settle (queued admitted then removed — no leak)",
      sem2.snapshot().active === 0 && sem2.snapshot().queued === 0 && sem2.snapshot().entries.length === 0);
  }

  // Throw path: a rejecting fn (a real runner exception / kill / timeout all look the same here) must
  // remove its registry entry AND release its slot — no phantom active gate, no deadlock.
  {
    const sem3 = new GateSemaphore();
    await sem3.runExclusive(1, desc("boom"), async () => { throw new Error("boom"); }).catch(() => {});
    check("(unit, throw) registry empty after a throwing fn (no leaked holder)",
      sem3.snapshot().active === 0 && sem3.snapshot().entries.length === 0);
    const after = await sem3.runExclusive(1, desc("after"), async () => "released");
    check("(unit, throw) a slot is released even when fn rejects", after === "released");
  }

  // A queued gate behind a THROWING holder still gets admitted — the holder's throw must free the lane in
  // its finally, exactly as a clean settle would (covers the reject/timeout-then-drain path end to end).
  {
    const sem4 = new GateSemaphore();
    const pThrow = sem4.runExclusive(1, desc("hold"), async () => { await sleep(30); throw new Error("timeout"); }).catch(() => "threw");
    const pWait = sem4.runExclusive(1, desc("wait"), async () => "admitted-after-throw");
    const [a, b] = await Promise.all([pThrow, pWait]);
    check("(unit, throw) a queued gate is admitted after the holder throws (lane freed in finally)",
      a === "threw" && b === "admitted-after-throw");
    check("(unit, throw) registry empty after the throw + queued both settle", sem4.snapshot().entries.length === 0);
  }
}

// ── PER-REPO MERGE-ADMISSION GUARD (card 92e960d1): two `merge`-kind gates for the SAME repo must never
// both be RUNNING at once, regardless of `cap` headroom — closing the class where two same-repo merges
// race to squash and one is guaranteed to burn a full gate run before `mergeBranchLocked`'s
// `requireCanonicalHead` re-check fail-closed-aborts it. Two DIFFERENT repos, and two non-`merge` gate
// types sharing a repoPath, must stay fully concurrent — the guard is scoped narrowly on purpose
// (DoD-2/DoD-3), and a leaked hold would PERMANENTLY deadlock every future merge on that repo (no
// timeout, no self-heal), so the release path gets exhaustive coverage across every terminal shape.
{
  const mergeDesc = (id, repoPath) => ({ gateType: "merge", projectId: `proj-${id}`, sessionId: `sess-${id}`, repoPath });

  // (a) SAME repoPath, cap 2 (real headroom on `active`): the second merge must be QUEUED, not admitted
  // concurrently — proving this is the REPO guard, not just cap contention.
  //
  // Uses assertNeverWithControl (_timing-guard.mjs), not a bare fixed wait: a prior draft of this test
  // proved `!secondStarted` true SYNCHRONOUSLY, immediately after `pSecond` was assigned, reasoning that
  // `acquire()`'s admission decision is synchronous — TRUE, but irrelevant to what this assertion needs:
  // `fn` invocation is deferred at least one MICROTASK past `await acquire()` regardless of which branch
  // admitted it, so `secondStarted` reads false at that instant whether the guard blocks it or not. Proven
  // empirically: temporarily neutering `mergeRepoFree` to `return true` unconditionally left that
  // synchronous check GREEN even though the second merge was now (wrongly) admitted immediately — the
  // exact vacuous-pass shape the fixed-wait guard exists to catch, just reached by a different path than
  // an insufficient sleep. `assertNeverWithControl` requires a `positiveControl` that proves the SAME
  // observation window CAN catch a real start before trusting a negative result from it — using an
  // UNRELATED (different repo, different semaphore instance, different flag) merge to arm that proof, so
  // it never shares state with the real scenario under test.
  {
    const sem = new GateSemaphore();
    let releaseHolder;
    const holder = () => new Promise((res) => { releaseHolder = res; });
    const pHolder = sem.runExclusive(2, mergeDesc("h", "/repo/shared"), () => holder());
    check("(repo-mutex, a) the holder admits immediately (cap headroom, repo free — synchronous fast path)", sem.snapshot().active === 1);
    let secondStarted = false;
    const pSecond = sem.runExclusive(2, mergeDesc("s", "/repo/shared"), async () => { secondStarted = true; return "second"; });
    check("(repo-mutex, a) cap has real headroom (1 active out of cap 2)", sem.snapshot().active === 1);
    check("(repo-mutex, a) the queue genuinely holds the second merge", sem.snapshot().queued === 1);
    const queuedEntry = sem.snapshot().entries.find((e) => e.phase === "queued");
    check("(repo-mutex, a) the queued entry is visibly repoContended (not a silent, unexplained wait)",
      !!queuedEntry && queuedEntry.repoContended === true);

    const REPO_MUTEX_WINDOW_MS = 150; // generous relative to a plain in-memory admission decision
    const neverStarted = await assertNeverWithControl({
      label: "(repo-mutex, a) the SECOND same-repo merge never starts while the first holds the repo",
      check: () => secondStarted,
      windowMs: REPO_MUTEX_WINDOW_MS,
      positiveControl: async () => {
        const controlSem = new GateSemaphore();
        let controlStarted = false;
        const pControl = controlSem.runExclusive(2, mergeDesc("ctrl", "/repo/different"), async () => { controlStarted = true; return "control"; });
        const observed = await observeOnce({ check: () => controlStarted, windowMs: REPO_MUTEX_WINDOW_MS });
        await pControl; // let the control's own op settle cleanly before returning
        return observed;
      },
    });
    check("(repo-mutex, a) the SECOND same-repo merge PROVABLY did not start — the SAME window just proved (via the control) capable of catching a real start", neverStarted);

    // By now `assertNeverWithControl` has consumed a real observation window, so the holder's `fn` (which
    // assigns `releaseHolder`) has long since run — no poll needed here, unlike the earlier draft.
    releaseHolder("first");
    const [r1, r2] = await Promise.all([pHolder, pSecond]);
    check("(repo-mutex, a) both eventually settle once the first releases", r1 === "first" && r2 === "second");
  }

  // (b) DIFFERENT repoPath, cap 2: both merges run TRULY concurrently — the positive control's other
  // half (a fix that just serializes everything would fail this).
  {
    const sem = new GateSemaphore();
    let active = 0, maxActive = 0;
    const task = async () => { active++; maxActive = Math.max(maxActive, active); await sleep(60); active--; return "ok"; };
    const [r1, r2] = await Promise.all([
      sem.runExclusive(2, mergeDesc("x", "/repo/one"), task),
      sem.runExclusive(2, mergeDesc("y", "/repo/two"), task),
    ]);
    check("(repo-mutex, b) two DIFFERENT repos run truly concurrently (not cross-serialized)", maxActive === 2);
    check("(repo-mutex, b) both settle", r1 === "ok" && r2 === "ok");
  }

  // (c) worker/deploy gateTypes sharing a repoPath are STRUCTURALLY unaffected (DoD-2) — even with
  // repoPath deliberately set on a non-merge descriptor here, mergeRepoFree() is gateType-gated FIRST,
  // so this is belt-and-braces, not merely "no current call site sets it there".
  {
    const sem = new GateSemaphore();
    let active = 0, maxActive = 0;
    const task = async () => { active++; maxActive = Math.max(maxActive, active); await sleep(60); active--; return "ok"; };
    const workerDesc = { gateType: "worker", projectId: "p", sessionId: "s1", repoPath: "/repo/shared" };
    const deployDesc = { gateType: "deploy", projectId: "p", sessionId: "s2", repoPath: "/repo/shared" };
    const [r1, r2] = await Promise.all([sem.runExclusive(2, workerDesc, task), sem.runExclusive(2, deployDesc, task)]);
    check("(repo-mutex, c) worker+deploy sharing a repoPath still run concurrently — guard is merge-only", maxActive === 2);
    check("(repo-mutex, c) both settle", r1 === "ok" && r2 === "ok");
  }

  // (d) RELEASE-PATH EXHAUSTIVENESS — a leaked `activeMergeRepos` entry would PERMANENTLY deadlock every
  // future merge on that repo. Prove every terminal path frees it, via the ONLY externally-observable
  // proof available (no direct access to the private Set): a FRESH same-repo merge admits near-instantly
  // afterward — if anything were still (incorrectly) held, this probe would itself hang/queue.
  const repoFreedAfter = async (sem, repoPath) => {
    const started = Date.now();
    await sem.runExclusive(2, { gateType: "merge", projectId: "p", sessionId: `probe-${Date.now()}`, repoPath }, async () => "probe");
    return Date.now() - started < 200;
  };

  // (d1) clean resolve
  {
    const sem = new GateSemaphore();
    await sem.runExclusive(2, mergeDesc("d1", "/repo/d1"), async () => "ok");
    check("(repo-mutex, d1) a clean resolve frees the repo hold", await repoFreedAfter(sem, "/repo/d1"));
  }
  // (d2) a throwing fn (a real runner exception/kill/timeout all look the same here)
  {
    const sem = new GateSemaphore();
    await sem.runExclusive(2, mergeDesc("d2", "/repo/d2"), async () => { throw new Error("boom"); }).catch(() => {});
    check("(repo-mutex, d2) a throwing fn still frees the repo hold", await repoFreedAfter(sem, "/repo/d2"));
  }
  // (d3) withdrawn while QUEUED (zero process risk by construction — fn never invoked)
  {
    const sem = new GateSemaphore();
    let releaseHolder;
    const holder = () => new Promise((res) => { releaseHolder = res; });
    const pHolder = sem.runExclusive(1, mergeDesc("d3h", "/repo/d3"), () => holder());
    await sleep(20);
    const pQueued = sem.runExclusive(1, mergeDesc("d3q", "/repo/d3"), async () => "should-not-run").catch((e) => e);
    await sleep(20);
    const queuedId = sem.snapshot().entries.find((e) => e.phase === "queued")?.id;
    check("(repo-mutex, d3) precondition: a queued entry exists to cancel", !!queuedId);
    check("(repo-mutex, d3) cancelQueued reports success", sem.cancelQueued(queuedId, "manual", "test-cancel") === true);
    const qResult = await pQueued;
    check("(repo-mutex, d3) the withdrawn waiter rejects with GateCancelledError, never ran", qResult instanceof GateCancelledError);
    releaseHolder("first");
    await pHolder;
    check("(repo-mutex, d3) the repo hold frees cleanly once the still-running holder releases (queued-cancel never touched it)",
      await repoFreedAfter(sem, "/repo/d3"));
  }
  // (d4) asked to stop while RUNNING (fn honors the abort signal by throwing — mirrors how a real gate
  // step's runner reacts to `cancelRunning`)
  {
    const sem = new GateSemaphore();
    const p = sem.runExclusive(1, mergeDesc("d4", "/repo/d4"), async (_startedAt, cancelSignal) => {
      await new Promise((_resolve, reject) => {
        cancelSignal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }).catch((e) => e);
    await sleep(20); // let it genuinely admit
    const runningId = sem.snapshot().entries.find((e) => e.phase === "running")?.id;
    check("(repo-mutex, d4) precondition: a running entry exists to cancel", !!runningId);
    check("(repo-mutex, d4) cancelRunning reports it asked a live entry", sem.cancelRunning(runningId, "test-abort") === true);
    const result = await p;
    check("(repo-mutex, d4) the running fn actually threw on abort", result instanceof Error && result.message === "aborted");
    check("(repo-mutex, d4) an aborted-then-thrown run still frees the repo hold", await repoFreedAfter(sem, "/repo/d4"));
  }

  // (e) THE QUEUE PATH (card 96d5f76b, DoD-2): (a) above proves the second same-repo merge never starts
  // while nothing else happens around it — but that's the ADMISSION path (`acquire()`'s synchronous
  // fast-path check), never the QUEUE path production actually hit in the 2026-08-05 incident this card
  // investigates: a same-repo sibling sitting QUEUED while an UNRELATED op (different repo, different
  // project) admits and releases, firing a REAL `grantNext()` scan that must correctly skip the still-
  // repo-blocked waiter rather than admit it just because a cap slot happened to free. A cap-only guard
  // (or a `grantNext()` that forgot to re-check `mergeRepoFree`) would pass (a) — nothing there ever frees
  // an unrelated slot — and only this test exercises the actual mechanism that failed to explain the
  // incident's ~28s (later narrowed to ≤3.4s) window where the repo guard was found absent with no known
  // caller responsible. This test does not reproduce THAT incident (no known code path causes it, per this
  // card's own investigation) — it proves the ORDINARY queue path stays correct under the exact trigger
  // shape (an unrelated release) that production's 07:29:22.900 admission coincided with.
  {
    const sem = new GateSemaphore();
    let releaseHolder;
    const holder = () => new Promise((res) => { releaseHolder = res; });
    const pHolder = sem.runExclusive(2, mergeDesc("eh", "/repo/queue-path"), () => holder());
    check("(repo-mutex, e) the holder admits immediately (repo free, cap headroom)", sem.snapshot().active === 1);

    let siblingStarted = false;
    // NO sleep needed here (mirrors (a)'s identical proven shape above): `acquire()`'s admission decision
    // — including a QUEUED waiter's registry push, inside the `new Promise` executor — is entirely
    // SYNCHRONOUS, completing before `runExclusive(...)` ever returns control to this line. A fixed wait
    // here would be a genuine TIMING-GUARD violation (an unfalsifiable "hasn't happened yet" vs "never
    // will"); checking synchronously is not a race because there is nothing async to race.
    const pSibling = sem.runExclusive(2, mergeDesc("es", "/repo/queue-path"), async () => { siblingStarted = true; return "sibling"; });
    check("(repo-mutex, e) the sibling is genuinely QUEUED, not admitted (cap has headroom — this IS repo contention)",
      sem.snapshot().queued === 1 && sem.snapshot().active === 1);
    const queuedEntry = sem.snapshot().entries.find((e) => e.phase === "queued");
    check("(repo-mutex, e) the queued sibling is visibly repoContended", !!queuedEntry && queuedEntry.repoContended === true);

    // Free an UNRELATED slot: an entirely different repo/project admits into the second cap slot, then
    // resolves and releases — the SAME `release()` → `grantNext()` call production's own peer-project
    // merge made in the real incident. This is the trigger the fixed-wait guard below needs a genuine
    // event to anchor on, not a bare sleep.
    await sem.runExclusive(2, { gateType: "merge", projectId: "unrelated", sessionId: "unrelated-sess", repoPath: "/repo/totally-different" }, async () => "unrelated-done");
    check("(repo-mutex, e) the unrelated op's release did NOT touch the repo-blocked sibling's queued state",
      sem.snapshot().queued === 1 && sem.snapshot().active === 1);

    const QUEUE_PATH_WINDOW_MS = 150;
    const neverStarted = await assertNeverWithControl({
      label: "(repo-mutex, e) the sibling STAYS QUEUED after an UNRELATED slot frees — the queue path, not just admission",
      check: () => siblingStarted,
      windowMs: QUEUE_PATH_WINDOW_MS,
      positiveControl: async () => {
        const controlSem = new GateSemaphore();
        let controlStarted = false;
        const pControl = controlSem.runExclusive(2, mergeDesc("ectrl", "/repo/queue-path-control"), async () => { controlStarted = true; return "control"; });
        const observed = await observeOnce({ check: () => controlStarted, windowMs: QUEUE_PATH_WINDOW_MS });
        await pControl;
        return observed;
      },
    });
    check("(repo-mutex, e) the sibling PROVABLY did not start after the unrelated release — the same window just proved (via the control) capable of catching a real start", neverStarted);

    releaseHolder("holder-done");
    const [rHolder, rSibling] = await Promise.all([pHolder, pSibling]);
    check("(repo-mutex, e) once the ACTUAL holder releases, the sibling is admitted and settles", rHolder === "holder-done" && rSibling === "sibling");
  }
}

// ── REPO-GUARD-ONLY PRIMITIVE (card b9e07a4a): acquireRepoGuardOnly ────────────────────────────────
// Built for the `db9b0130` inert-diff skip: it never calls runExclusive (no gate to run), so it was
// structurally invisible to the per-repo merge-admission guard entirely — b9e07a4a's reachability
// finding was that this is reachable by an ORDINARY manager slip (firing a second same-repo
// worker_merge_confirm while a first is still mid-gate), not just a deliberate protocol violation, and
// closing it needed a NEW primitive: the reviewer's original suggestion (route the inert skip through
// `runExclusive`) does not work, because `runExclusive`'s `acquire()` gates on `cap` AND `mergeRepoFree`
// TOGETHER — an inert merge routed through it would queue behind CAP contention too, reintroducing
// exactly the gate-lane wait the inert-diff skip exists to avoid. `acquireRepoGuardOnly` waits ONLY on
// the repo guard, never on cap — these tests prove that split holds, in both directions, and that the
// release path is exhaustive (a leaked hold here would PERMANENTLY deadlock every future merge on that
// repo, same severity as the existing `beginSquash`/`endSquash` release-path tests above).
{
  // Descriptor helper: acquireRepoGuardOnly now takes a full RepoGuardOnlyDescriptor (card b9e07a4a Code
  // Review — projectId/sessionId/taskId/branch let gate_queue label + redact a repo-guard-only entry
  // exactly like a real gate run; opId is REQUIRED, since it's what makes the entry findable by
  // gate_cancel, even though the ACTUAL acquire/release identity is an internally-minted token,
  // independent of this value — see that method's own doc).
  const rgoDesc = (repoPath, opId, extra) => ({ repoPath, projectId: "p", sessionId: `sess-${opId}`, opId, ...extra });

  const repoFreedAfter = async (sem, repoPath) => {
    const started = Date.now();
    const release = await sem.acquireRepoGuardOnly(rgoDesc(repoPath, `probe-${Date.now()}`));
    release();
    return Date.now() - started < 200;
  };

  // (a) NEVER TOUCHES CAP: a cap-1 semaphore fully saturated by an UNRELATED op (no repoPath) must not
  // block acquireRepoGuardOnly for a free repoPath at all — proving DoD-2's "must never touch the cap"
  // property directly, not merely by absence of a counter-example.
  {
    const sem = new GateSemaphore();
    let releaseHolder;
    const holder = () => new Promise((res) => { releaseHolder = res; });
    const pHolder = sem.runExclusive(1, { gateType: "worker", projectId: "p", sessionId: "cap-holder" }, () => holder());
    await sleep(20);
    check("(repo-guard-only, a) precondition: cap is fully saturated (active === cap === 1)", sem.snapshot().active === 1);

    const started = Date.now();
    const release = await sem.acquireRepoGuardOnly(rgoDesc("/repo/uncontended", "op-a"));
    const elapsedMs = Date.now() - started;
    check("(repo-guard-only, a) acquireRepoGuardOnly resolves near-instantly DESPITE a fully saturated cap (never queues behind it)", elapsedMs < 200);
    release();
    check("(repo-guard-only, a) it never touched `active` at all (still exactly the one unrelated cap-holder)", sem.snapshot().active === 1);

    releaseHolder("done");
    await pHolder;
  }

  // (b) CONTENDED BY A REAL, runExclusive-ADMITTED MERGE (the headline scenario this card fixes): the
  // repo-guard-only acquire must NOT resolve while a real merge gate holds the SAME repoPath — including
  // past the gate's own settle, since a real merge extends its hold via `holdRepoGuardOnExit` through its
  // own squash phase (`endSquash`) exactly as `confirmWorkerMerge` does. Only once `endSquash` fires does
  // the waiter resolve. The admit-side descriptor MUST carry a real `opId` (card b9e07a4a Code Review):
  // `admit()`'s stored identity is `descriptor.opId ?? entry.id` (see `repoHolderId`'s own doc), and only
  // an opId this test ALSO presents to `endSquash` can ever match it — an admit with no opId would fall
  // back to the internal `entry.id`, which this test has no way to present externally, and `endSquash`
  // would be a safe no-op FOREVER (the exact identity-mismatch guard this card added, now correctly
  // exercised rather than accidentally defeating the test).
  {
    const sem = new GateSemaphore();
    let releaseGate;
    const pGate = sem.runExclusive(2, { gateType: "merge", projectId: "p", sessionId: "real-gate", repoPath: "/repo/contended", opId: "real-gate-op" },
      async (_startedAt, _cancelSignal, _hooks, _getMax, holdRepoGuardOnExit) => {
        holdRepoGuardOnExit(); // real confirmWorkerMerge shape: hold survives the gate's own settle
        await new Promise((res) => { releaseGate = res; });
        return "gate-done";
      });
    await sleep(20);
    check("(repo-guard-only, b) the real gate admits and holds the repo (extended past its own settle)", sem.snapshot().active === 1);

    let acquired = false;
    const pAcquire = sem.acquireRepoGuardOnly(rgoDesc("/repo/contended", "inert-op")).then((release) => { acquired = true; return release; });

    const WINDOW_MS = 150;
    const neverAcquired = await assertNeverWithControl({
      label: "(repo-guard-only, b) the inert-skip's acquire never resolves while the real gate holds the repo",
      check: () => acquired,
      windowMs: WINDOW_MS,
      positiveControl: async () => {
        const controlSem = new GateSemaphore();
        let controlAcquired = false;
        const pControl = controlSem.acquireRepoGuardOnly(rgoDesc("/repo/uncontended-control", "ctrl")).then((r) => { controlAcquired = true; return r; });
        const observed = await observeOnce({ check: () => controlAcquired, windowMs: WINDOW_MS });
        (await pControl)(); // release the control's own hold
        return observed;
      },
    });
    check("(repo-guard-only, b) PROVABLY did not acquire while contended — the same window just proved (via the control) capable of catching a real acquire", neverAcquired);

    // The gate itself settles (releases its cap slot) — the repo hold SURVIVES (holdRepoGuardOnExit was
    // declared), so the waiter must STILL not be acquired yet. NO sleep here (a fixed wait guarding this
    // negative assertion would be unfalsifiable — "hasn't happened yet" vs "never will"): `await pGate`
    // itself IS the deterministic wait — `runExclusive`'s `finally` (registry.delete then release(), see
    // that method's own doc) runs fully synchronously with no yield point, and since `holdRepoGuard` is
    // true here, `release()`'s own repo-freeing branch is skipped entirely — nothing between `pGate`
    // settling and this line could possibly free the repo or resolve `pAcquire`. Sound the instant `pGate`
    // resolves, not merely "probably true by then" (mirrors gate-semaphore-concurrency.mjs's own
    // "(join) (3)" precedent for the same reasoning).
    releaseGate("go");
    await pGate;
    check("(repo-guard-only, b) still not acquired after the gate's own settle — the hold survives past it", acquired === false);

    // Only `endSquash` (the deferred release confirmWorkerMerge calls after its own squash) actually frees
    // the repo — this is the `releaseMergeRepoGuard` routing through `freeRepoPath`'s hand-off. The opId
    // MUST match what `runExclusive`'s own descriptor above carried ("real-gate-op") — see this block's
    // own header comment for why a mismatch here would silently defeat the test instead of failing it.
    sem.endSquash("/repo/contended", "real-gate-op");
    const release = await pAcquire;
    check("(repo-guard-only, b) acquired the instant endSquash frees the repo (direct hand-off)", acquired === true);
    release();
    check("(repo-guard-only, b) repo genuinely free afterward", await repoFreedAfter(sem, "/repo/contended"));
  }

  // (c) HANDOFF TO A QUEUED REAL GATE (the reverse direction of (b)): a real merge gate queued behind an
  // inert-skip's OWN hold must be admitted the instant that hold releases — proving the two mechanisms
  // compose in both directions, not just one.
  {
    const sem = new GateSemaphore();
    const release1 = await sem.acquireRepoGuardOnly(rgoDesc("/repo/reverse", "inert-1"));
    check("(repo-guard-only, c) the inert-skip acquires the free repo immediately", true);

    // NO sleep here, deliberately (mirrors the existing "(repo-mutex, e)" precedent above in this same
    // file): `acquire()`'s admission decision — including a QUEUED waiter's registry push, inside the `new
    // Promise` executor — is entirely SYNCHRONOUS, completing before `runExclusive(...)` ever returns
    // control to this line. A fixed wait here would be a genuine TIMING-GUARD violation (an unfalsifiable
    // "hasn't happened yet" vs "never will"); checking synchronously is not a race because there is
    // nothing async to race.
    let gateStarted = false;
    const pGate = sem.runExclusive(2, { gateType: "merge", projectId: "p", sessionId: "queued-gate", repoPath: "/repo/reverse" },
      async () => { gateStarted = true; return "gate-done"; });
    check("(repo-guard-only, c) the real gate is genuinely QUEUED behind the inert-skip's hold (cap has headroom)",
      sem.snapshot().queued === 1 && sem.snapshot().active === 0);
    const queuedEntry = sem.snapshot().entries.find((e) => e.phase === "queued");
    check("(repo-guard-only, c) visibly repoContended, not a silent unexplained wait", !!queuedEntry && queuedEntry.repoContended === true);

    release1();
    const gateResult = await pGate;
    check("(repo-guard-only, c) the queued real gate is admitted and settles once the inert-skip releases", gateStarted === true && gateResult === "gate-done");
  }

  // (d) RELEASE-PATH EXHAUSTIVENESS — a leaked hold here PERMANENTLY deadlocks every future merge on that
  // repo (no timeout, no self-heal), same severity class as the beginSquash/endSquash coverage above. Two
  // shapes: a clean release, and — the throw/cancel path a fixed-wait or happy-path-only test would miss
  // (card 1f1f3d12) — a release fired from a `finally` after the surrounding caller code throws, the EXACT
  // idiom `confirmWorkerMerge`'s own try/finally uses around this primitive.
  {
    // (d1) clean release
    const sem = new GateSemaphore();
    const release = await sem.acquireRepoGuardOnly(rgoDesc("/repo/d1", "op-d1"));
    release();
    check("(repo-guard-only, d1) a clean release frees the repo hold", await repoFreedAfter(sem, "/repo/d1"));
  }
  {
    // (d2) THROW PATH: release fired from a `finally` after the caller's own code throws between acquire
    // and its intended cleanup — mirrors confirmWorkerMerge's `try { ... } finally { releaseInertRepoGuard
    // ?.(); }` bracket exactly. A release that only ever fires on the CLEAN path (the gap card 1f1f3d12
    // flagged for the per-worktree guard) would leave this repo permanently held.
    const sem = new GateSemaphore();
    let release;
    const threw = await (async () => {
      try {
        release = await sem.acquireRepoGuardOnly(rgoDesc("/repo/d2", "op-d2"));
        throw new Error("simulated failure between acquire and mergeBranch");
      } finally {
        release?.();
      }
    })().then(() => "resolved", (e) => e.message);
    check("(repo-guard-only, d2) the surrounding code genuinely threw (this test exercises the throw path, not a no-op)",
      threw === "simulated failure between acquire and mergeBranch");
    check("(repo-guard-only, d2) the repo hold is STILL freed even though the caller threw", await repoFreedAfter(sem, "/repo/d2"));
  }
  {
    // (d3) double-release idempotency: a second call to the returned release() must be a harmless no-op,
    // never a double-free that could hand the same hold to two different waiters.
    const sem = new GateSemaphore();
    const release = await sem.acquireRepoGuardOnly(rgoDesc("/repo/d3", "op-d3"));
    release();
    release(); // must not throw, must not double-grant
    check("(repo-guard-only, d3) a second release() call is a harmless no-op", await repoFreedAfter(sem, "/repo/d3"));
  }
  {
    // (d4) a QUEUED repo-guard-only waiter, released via the SAME idempotent-release contract as (d3) —
    // proves the FIFO hand-off path (not just the uncontended fast path) also tolerates a double-release
    // from either side without corrupting the next waiter's turn.
    const sem = new GateSemaphore();
    const releaseFirst = await sem.acquireRepoGuardOnly(rgoDesc("/repo/d4", "op-d4-first"));
    // NO sleep here, same reasoning as (c) above: `acquireRepoGuardOnly`'s contended branch pushes onto
    // `repoGuardOnlyWaiters` SYNCHRONOUSLY, inside the `new Promise` executor, before this call even
    // returns control to this line — checking immediately is sound, not a race.
    let secondAcquired = false;
    const pSecond = sem.acquireRepoGuardOnly(rgoDesc("/repo/d4", "op-d4-second")).then((r) => { secondAcquired = true; return r; });
    check("(repo-guard-only, d4) precondition: the second waiter is genuinely queued", secondAcquired === false);
    releaseFirst();
    releaseFirst(); // redundant — must not corrupt the hand-off to the second waiter
    const releaseSecond = await pSecond;
    check("(repo-guard-only, d4) the second waiter is granted exactly once via hand-off, unaffected by the first's redundant release", secondAcquired === true);
    releaseSecond();
    check("(repo-guard-only, d4) repo genuinely free after both settle", await repoFreedAfter(sem, "/repo/d4"));
  }

  // (e) THE EXACT CRITICAL CASCADE (Code Review, card b9e07a4a): op A's real gate FAILS (never calls
  // holdRepoGuardOnExit) → its own release() frees/hands off repoPath to a queued repo-guard-only waiter
  // B → but confirmWorkerMerge's OUTER finally still unconditionally fires `endSquash(repoPath, A's
  // opId)` (gated on `gateRan`, which was set true BEFORE the gate ever ran — see that flag's own doc for
  // why it's true regardless of pass/fail). Before the identity fix, this deleted B's now-live hold — this
  // test reproduces that exact sequence at the semaphore level and proves B's hold survives A's redundant
  // endSquash call untouched.
  {
    const sem = new GateSemaphore();
    let releaseA;
    const pA = sem.runExclusive(2, { gateType: "merge", projectId: "p", sessionId: "A", repoPath: "/repo/e", opId: "op-A" },
      async () => { await new Promise((res) => { releaseA = res; }); return { passed: false }; }); // A's gate FAILS — holdRepoGuardOnExit is never called, mirroring runGateSeq's own contract
    await sleep(20);
    check("(repo-guard-only, e) precondition: A admits and holds /repo/e", sem.snapshot().active === 1);

    let bAcquired = false;
    const pB = sem.acquireRepoGuardOnly(rgoDesc("/repo/e", "op-B")).then((r) => { bAcquired = true; return r; });
    await sleep(20);
    check("(repo-guard-only, e) precondition: B is genuinely queued behind A", bAcquired === false);

    // A's gate settles (failed) — release() fires with holdRepoGuard:false (never declared), hands
    // /repo/e DIRECTLY to B via freeRepoPath's hand-off (inside that SAME `runExclusive` finally, so B is
    // already granted by the time `pA` itself settles).
    releaseA("done");
    await pA;
    const releaseB = await pB;
    check("(repo-guard-only, e) B is acquired once A's FAILED gate settles (hand-off from release(), not endSquash)", bAcquired === true);

    // THE BUG: confirmWorkerMerge's own finally still calls endSquash with A's opId regardless of
    // pass/fail — reproduce that exact call here, against B's now-live hold.
    sem.endSquash("/repo/e", "op-A");

    // B's hold must be COMPLETELY UNAFFECTED — provably, not by absence of a counter-example: a THIRD
    // same-repo merge gate must still be BLOCKED (queued, not admitted) after A's redundant endSquash,
    // exactly as it would be if B's hold were untouched.
    let cStarted = false;
    const pC = sem.runExclusive(2, { gateType: "merge", projectId: "p", sessionId: "C", repoPath: "/repo/e" },
      async () => { cStarted = true; return "c-done"; });
    const WINDOW_MS = 150;
    const neverStarted = await assertNeverWithControl({
      label: "(repo-guard-only, e) a THIRD same-repo merge stays blocked — A's stale endSquash did NOT free B's live hold",
      check: () => cStarted,
      windowMs: WINDOW_MS,
      positiveControl: async () => {
        const controlSem = new GateSemaphore();
        let controlStarted = false;
        const pControl = controlSem.runExclusive(2, { gateType: "worker", projectId: "ctrl", sessionId: "ctrl" }, async () => { controlStarted = true; return "control"; });
        const observed = await observeOnce({ check: () => controlStarted, windowMs: WINDOW_MS });
        await pControl;
        return observed;
      },
    });
    check("(repo-guard-only, e) PROVABLY still blocked — B's hold survived A's stale endSquash intact", neverStarted);

    releaseB();
    const cResult = await pC;
    check("(repo-guard-only, e) once B genuinely releases, C is finally admitted", cStarted === true && cResult === "c-done");
  }

  // (f) PRIORITY INVERSION, DOCUMENTED (Code Review, card b9e07a4a — see `repoGuardOnlyWaiters`'s own
  // doc): a repo-guard-only waiter for a contended repoPath is handed the NEXT release BEFORE a
  // `highWaiters` entry for the SAME repoPath, even when that cap-based waiter queued FIRST and has been
  // waiting LONGER. Deliberate and accepted (a repo-guard-only wait is bounded by, at worst, another op's
  // near-instant squash, never a full gate run) — this test asserts the documented behavior directly
  // rather than merely asserting it isn't a crash.
  {
    const sem = new GateSemaphore();
    let releaseHolder;
    const pHolder = sem.runExclusive(2, { gateType: "merge", projectId: "p", sessionId: "holder", repoPath: "/repo/f", opId: "op-holder" },
      async () => { await new Promise((res) => { releaseHolder = res; }); return { passed: false }; });
    await sleep(20);
    check("(repo-guard-only, f) precondition: the holder admits", sem.snapshot().active === 1);

    // The CAP-BASED waiter queues FIRST.
    let capWaiterStarted = false;
    const pCapWaiter = sem.runExclusive(2, { gateType: "merge", projectId: "p", sessionId: "cap-waiter", repoPath: "/repo/f" },
      async () => { capWaiterStarted = true; return "cap-waiter-done"; });
    await sleep(20);
    check("(repo-guard-only, f) precondition: the cap-based waiter is genuinely queued FIRST", sem.snapshot().queued === 1);

    // The repo-guard-only waiter queues SECOND, strictly after.
    let rgoAcquired = false;
    const pRgoWaiter = sem.acquireRepoGuardOnly(rgoDesc("/repo/f", "op-rgo-waiter")).then((r) => { rgoAcquired = true; return r; });
    await sleep(20);
    check("(repo-guard-only, f) precondition: the repo-guard-only waiter is genuinely queued SECOND (strictly later)", rgoAcquired === false);

    // The holder's gate fails and releases — despite the cap-based waiter having queued FIRST, the
    // repo-guard-only waiter (queued SECOND) wins the hand-off.
    releaseHolder("done");
    await pHolder;
    const releaseRgo = await pRgoWaiter;
    check("(repo-guard-only, f) the LATER repo-guard-only waiter wins the hand-off over the EARLIER cap-based waiter", rgoAcquired === true);
    check("(repo-guard-only, f) the cap-based waiter (queued first) has NOT started yet — inversion confirmed", capWaiterStarted === false);

    releaseRgo();
    const capResult = await pCapWaiter;
    check("(repo-guard-only, f) the cap-based waiter is eventually admitted once the repo-guard-only waiter releases", capWaiterStarted === true && capResult === "cap-waiter-done");
  }
}

// ── CAP CHECK ON A NON-RELEASE-SHAPED grantNext() CALLER (card d9d5057f) ───────────────────────────
// grantNext() used to grant to the next eligible waiter by checking ONLY worktreeFree/mergeRepoFree,
// never `this.active < cap` — safe only under the assumption that both its callers are "release-shaped"
// (invoked exactly when a cap slot has JUST freed, so admitting one more waiter can't exceed cap).
// release() genuinely is: its own `this.active--` runs synchronously, immediately before it calls
// grantNext(). releaseMergeRepoGuard() (called via endSquash(), STANDALONE from `confirmWorkerMerge`,
// well after that same op's own release() already ran and already decremented `active`) is NOT: it frees
// a REPO guard, not a cap slot, and an entirely unrelated op can consume the already-freed cap slot in
// the gap between an op's release() and its later endSquash() call. THIS test constructs exactly that gap
// using only the public API (runExclusive + holdRepoGuardOnExit + endSquash — the real confirmWorkerMerge
// shape) and proves a cap-saturated grantNext() call, reached via endSquash(), can no longer over-admit.
{
  const sem = new GateSemaphore();
  const cap = 1;

  // A: a merge holding repoPath R, admits into the only cap-1 slot. Declares holdRepoGuardOnExit so its
  // repo hold survives PAST its own release() — the real confirmWorkerMerge shape (gateRan -> beginSquash
  // held via holdRepoGuardOnExit -> mergeBranch -> endSquash), see runExclusive's own doc.
  let releaseA;
  const pA = sem.runExclusive(cap, { gateType: "merge", projectId: "p", sessionId: "A", repoPath: "/repo/R", opId: "opA" },
    async (_startedAt, _cancelSignal, _hooks, _getMax, holdRepoGuardOnExit) => {
      holdRepoGuardOnExit();
      await new Promise((res) => { releaseA = res; });
      return "a-done";
    });
  await sleep(20); // let A genuinely admit
  check("(cap-on-grantNext) A admits into the only cap-1 slot", sem.snapshot().active === 1);

  // B: queued behind A, SAME repoPath — blocked by the repo guard (not by cap, which will free next).
  let bStarted = false;
  const pB = sem.runExclusive(cap, { gateType: "merge", projectId: "p", sessionId: "B", repoPath: "/repo/R" },
    async () => { bStarted = true; return "b-done"; });
  await sleep(20);
  check("(cap-on-grantNext) precondition: B is queued behind A's repo hold", sem.snapshot().queued === 1);

  // A resolves — release() fires: active-- (1 -> 0); the repo hold SURVIVES (holdRepoGuard was declared),
  // so grantNext()'s scan there finds B still repo-blocked and grants nothing. The cap slot is genuinely
  // free now, but B is still queued.
  releaseA("go");
  await pA;
  check("(cap-on-grantNext) after A settles: cap slot is free, but B is STILL queued (repo-blocked, not cap-blocked)",
    sem.snapshot().active === 0 && sem.snapshot().queued === 1);

  // C: a totally UNRELATED op (no repoPath) consumes the now-free cap slot via the ordinary acquire() path.
  let releaseC;
  const pC = sem.runExclusive(cap, { gateType: "worker", projectId: "p", sessionId: "C" },
    async () => { await new Promise((res) => { releaseC = res; }); return "c-done"; });
  await sleep(20);
  check("(cap-on-grantNext) C admits into the freed cap slot — cap is genuinely saturated again", sem.snapshot().active === 1);

  // A's squash phase finally settles (well after A's own release()) and calls endSquash — THE call this
  // card is about: it frees the repo guard and calls grantNext() while `active` is ALREADY back at cap
  // (C is running). A cap-blind grantNext() would see B is now repo-free and admit it anyway, over-admitting to 2.
  sem.endSquash("/repo/R", "opA");

  const CAP_WINDOW_MS = 150;
  const neverOverAdmitted = await assertNeverWithControl({
    label: "(cap-on-grantNext) B never starts while C still holds the only cap-1 slot — endSquash's grantNext() must not over-admit past cap",
    check: () => bStarted,
    windowMs: CAP_WINDOW_MS,
    positiveControl: async () => {
      const controlSem = new GateSemaphore();
      let controlStarted = false;
      const pControl = controlSem.runExclusive(1, { gateType: "worker", projectId: "ctrl", sessionId: "ctrl" }, async () => { controlStarted = true; return "control"; });
      const observed = await observeOnce({ check: () => controlStarted, windowMs: CAP_WINDOW_MS });
      await pControl;
      return observed;
    },
  });
  check("(cap-on-grantNext) B PROVABLY did not start while C held the only slot — no over-admission past cap 1", neverOverAdmitted);
  check("(cap-on-grantNext) active never exceeded cap at the observed point", sem.snapshot().active <= cap);

  releaseC("go");
  const [rB, rC] = await Promise.all([pB, pC]);
  check("(cap-on-grantNext) once C releases, B is finally admitted and settles", rB === "b-done" && rC === "c-done");
  check("(cap-on-grantNext) registry empty after all three settle (no leak)", sem.snapshot().entries.length === 0);
}

// ── MAX-CONCURRENT-OVER-RUN (card c6750500): `concurrentGates` (at-admission only) can never see a gate
// that starts ALONE and is joined mid-run — it reads 1 forever, even though the run spent most of its
// wall-clock contended. `concurrentGatesMax`, exposed via `runExclusive`'s 4th `fn` param
// `getMaxConcurrentGates`, is the fix: derived purely from GateSemaphore's own admit/release bookkeeping
// (no polling — see `admit()`'s own doc), it must reflect the true max concurrency observed at ANY point
// during the run, INCLUDING an entry that was already running when a later one joined it. Manually-
// released holders (no sleep-based timing races) make the admit/join/release sequence fully deterministic.
{
  const sem = new GateSemaphore();
  const descA = { gateType: "worker", projectId: "pA", sessionId: "sA" };
  const descB = { gateType: "worker", projectId: "pB", sessionId: "sB" };

  let releaseA, releaseB;
  let aConcurrentAtStart, aGetMax, bGetMax;
  const holdA = new Promise((res) => { releaseA = res; });
  const holdB = new Promise((res) => { releaseB = res; });

  // (1) A admits ALONE (cap 2 has headroom, but B hasn't even been started yet).
  const pA = sem.runExclusive(2, descA, async (_startedAt, _cancelSignal, _hooks, getMaxConcurrentGates) => {
    aConcurrentAtStart = sem.snapshot().active; // mirrors production's `concurrentGates` capture exactly
    aGetMax = getMaxConcurrentGates;
    await holdA;
    return "a-done";
  });
  await sleep(20); // let A genuinely acquire its slot before B ever starts
  check("(join) (1) A's at-admission concurrency reads 1 (admitted alone)", aConcurrentAtStart === 1);
  check("(join) (1) A's max reads 1 before anything joins it", aGetMax() === 1);

  // (2) B admits WHILE A is still running (cap 2 has headroom) — the "joined mid-run" shape (dbf1cd62:
  // admitted solo at 02:20:05Z, joined 02:33:03Z, recorded concurrentGates:1 for its whole run).
  const pB = sem.runExclusive(2, descB, async (_startedAt, _cancelSignal, _hooks, getMaxConcurrentGates) => {
    bGetMax = getMaxConcurrentGates;
    await holdB;
    return "b-done";
  });
  await sleep(20); // let B genuinely admit

  // ⭐ THE ASSERTION THAT MATTERS: BOTH A and B now read 2 — A's OWN recorded max reflects the join, not
  // just the joiner's. This is exactly the defect the card was filed against.
  check("(join) (2) A's max is bumped to 2 by B's admission — the ALREADY-RUNNING entry is attributed the join too", aGetMax() === 2);
  check("(join) (2) B's own max also reads 2 (it joined into an already-contended slot)", bGetMax() === 2);

  // (3) Release B first, let A keep running — A's recorded max must NOT decay back down when B leaves.
  // NO fixed wait here (a sleep-then-negative-assertion is unfalsifiable in one trial — see
  // fixed-wait-negative-guard.mjs): `await pB` is itself the deterministic wait for the precondition —
  // `runExclusive`'s `finally` (registry.delete then release(), see that method's own doc) is fully
  // synchronous with no yield point, so pB's OWN promise cannot settle until B's release has already been
  // fully processed. And there is no remaining path that could decrement `maxConcurrent` after that point
  // ANYWAY — it's bump-only by construction (`admit()`'s `e.maxConcurrent = this.active`, a monotonic
  // ratchet with no decrement anywhere in this file), so this assertion needs no clock at all: it is sound
  // the instant `pB` resolves, not merely "probably true by then."
  releaseB("go");
  await pB;
  check("(join) (3) A's max STAYS 2 after B releases — non-decreasing, not a live/current reading", aGetMax() === 2);

  // ⭐ DISCRIMINATING CONTROL (4): `concurrentGates` (at-admission, captured once at A's own start) must
  // STILL read 1 here — proving the two fields genuinely differ, not that `concurrentGatesMax` silently
  // became a copy of `concurrentGates`. Without this, a test where both fields read 2 can't tell a
  // working new field from one wired to the wrong source.
  check("(join) (4) A's at-admission concurrency (the concurrentGates field) is UNCHANGED at 1 — the two fields diverge", aConcurrentAtStart === 1);

  releaseA("go");
  const [ra, rb] = await Promise.all([pA, pB]);
  check("(join) both settle cleanly", ra === "a-done" && rb === "b-done");
  check("(join) registry empty after both settle (no leak)", sem.snapshot().entries.length === 0);
}

// ── Cap-transition logging (card 424ed9a8): `orchestration.maxConcurrentGates` is a daemon-global,
// safety-critical setting (cap>=1 is what makes the concurrent-squash-merge corruption trigger
// reachable at all) that was never logged anywhere — neither at boot nor on change — making an
// incident question like "was the cap >= 2 during this window" permanently unanswerable. Proves the
// semaphore itself logs `[gate] maxConcurrentGates <old> -> <new>` the moment it observes a DIFFERENT
// `cap` passed to `runExclusive` (the actual adoption point — not wherever config happens to be
// written), and stays silent when the cap is unchanged (including the very first call, where there is
// no "old" value to report).
{
  const sem = new GateSemaphore();
  const desc = { gateType: "worker", projectId: "p", sessionId: "s" };
  const originalLog = console.log;
  // Spy ONLY around the `runExclusive` call itself, restoring the real console.log before every `check()`
  // — `check()` calls `console.log` too, so leaving the spy on across a `check()` would silently swallow
  // its own PASS/FAIL line instead of ever reporting a real failure.
  const withSpy = async (cap) => {
    const logs = [];
    console.log = (...args) => { logs.push(args.join(" ")); };
    try {
      await sem.runExclusive(cap, desc, async () => "ok");
    } finally {
      console.log = originalLog;
    }
    return logs;
  };
  try {
    let logs = await withSpy(1);
    check("(transition) the FIRST call (no prior observed cap) logs nothing — not a transition from nothing", logs.length === 0);

    logs = await withSpy(1);
    check("(transition) a repeated, UNCHANGED cap logs nothing", logs.length === 0);

    logs = await withSpy(2);
    check("(transition) cap 1 -> 2 logs the transition with the correct old/new values",
      logs.some((l) => l.includes("[gate] maxConcurrentGates 1 -> 2")));

    logs = await withSpy(2);
    check("(transition) after adopting 2, an unchanged repeat logs nothing again", logs.length === 0);

    logs = await withSpy(5);
    check("(transition) a SECOND distinct change (2 -> 5) logs correctly (not a one-shot latch)",
      logs.some((l) => l.includes("[gate] maxConcurrentGates 2 -> 5")));
  } finally {
    console.log = originalLog;
  }
}

// ── Pure unit check: priority-aware queue ordering (card 24642c3d — a low-priority worker run_gate
//    self-check must not head-of-line-block a higher-priority merge/deploy gate queued behind it) ────
{
  const sem = new GateSemaphore();
  // A shared descriptor — this block exercises QUEUE ORDERING, not the registry, so one read-only
  // descriptor for every run is fine (each runExclusive wraps it in its own entry). runExclusive's new
  // signature is (cap, descriptor, fn, priority) — the `task(...)` fn ignores the startedAt it's handed.
  const d = { gateType: "worker", projectId: "p", sessionId: "s" };
  const order = [];
  let active = 0, maxActive = 0;
  const task = (label, ms) => async () => {
    order.push(label); active++; maxActive = Math.max(maxActive, active);
    await sleep(ms);
    active--;
    return label;
  };

  // cap 1: "holder" grabs the only slot immediately. While it holds, queue TWO low-priority waiters,
  // THEN a high-priority one (arrives LAST). A plain FIFO queue would run low1, low2, high in arrival
  // order — the priority queue must run high BEFORE the already-queued low2 (low1 is unaffected: it
  // queued before the holder even released, so nothing could have jumped ahead of it — the guarantee is
  // ONLY that high jumps LOW waiters queued ahead of it, not that it jumps EVERYTHING).
  const holder = sem.runExclusive(1, d, task("holder", 150));
  await sleep(20); // ensure "holder" has genuinely acquired the slot before anything else queues
  const low1 = sem.runExclusive(1, d, task("low1", 20), "low");
  await sleep(10);
  const low2 = sem.runExclusive(1, d, task("low2", 20), "low");
  await sleep(10);
  const high = sem.runExclusive(1, d, task("high", 20), "high");

  await Promise.all([holder, low1, low2, high]);
  check("(priority) all four ran", order.length === 4);
  check("(priority) cap 1 held throughout — priority reorders the QUEUE, never lets more than 1 run at once", maxActive === 1);
  check("(priority) the holder (already running before anything queued) ran first", order[0] === "holder");
  check("(priority) the HIGH-priority waiter (queued LAST) is serviced BEFORE the already-queued low2 — no head-of-line blocking",
    order.indexOf("high") < order.indexOf("low2"));
  check("(priority) low1 (queued before low2) still keeps its place ahead of low2 — same-tier FIFO preserved",
    order.indexOf("low1") < order.indexOf("low2"));

  // Same-priority-only queue stays strict FIFO (regression check, no "high" tier involved at all).
  const semFifo = new GateSemaphore();
  const fifoOrder = [];
  const fifoTask = (label) => async () => { fifoOrder.push(label); await sleep(20); return label; };
  const fh = semFifo.runExclusive(1, d, fifoTask("h"), "low");
  await sleep(10);
  const f1 = semFifo.runExclusive(1, d, fifoTask("f1"), "low");
  const f2 = semFifo.runExclusive(1, d, fifoTask("f2"), "low");
  const f3 = semFifo.runExclusive(1, d, fifoTask("f3"), "low");
  await Promise.all([fh, f1, f2, f3]);
  check("(priority) same-tier queue stays strict FIFO", JSON.stringify(fifoOrder) === JSON.stringify(["h", "f1", "f2", "f3"]));

  // Omitting priority entirely defaults to "high" — an untouched call site behaves exactly as before
  // this card (every caller was implicitly equal-priority FIFO, i.e. all "high"). Proved by showing the
  // omitted-priority call still jumps an already-queued "low" waiter, not by absence-of-throw alone.
  const semDefault = new GateSemaphore();
  const defaultOrder = [];
  const dTask = (label, ms = 20) => async () => { defaultOrder.push(label); await sleep(ms); return label; };
  const dHolder = semDefault.runExclusive(1, d, dTask("dholder", 150)); // holds well past both queue-ins below, avoiding a release/push race
  await sleep(10);
  const dLow = semDefault.runExclusive(1, d, dTask("dlow"), "low");
  await sleep(10);
  const dNoArg = semDefault.runExclusive(1, d, dTask("dnoarg")); // priority omitted
  await Promise.all([dHolder, dLow, dNoArg]);
  check("(priority) an omitted-priority call defaults to high and jumps an already-queued low waiter",
    defaultOrder.indexOf("dnoarg") < defaultOrder.indexOf("dlow"));
}

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# gs\n");
  execSync(`git init -q && git config user.email gs@loom && git config user.name gs && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

// Seeds ONE manager + TWO workers, each in its OWN project/repo (confirmWorkerMerge derives the repo
// from the WORKER's own projectId, not the manager's — so this is a legitimate shape, not a synthetic
// one) — deliberately NOT two workers sharing one repo: two REAL concurrent squash-merges into the
// SAME shared repoPath race each other on git's own state (a separate, pre-existing concurrency
// property of the merge/union-merge git operations, unrelated to the gate semaphore this test targets)
// and would make this test flaky for a reason that has nothing to do with GateSemaphore. Separate repos
// isolate the git side entirely, so the only shared resource left is the semaphore itself.
async function seedTwoWorkers(sfx, reposDir) {
  const db = new Db();
  dbs.push(db);
  const agentId = `gs-agent-${sfx}`, mgrId = `gs-mgr-${sfx}`;
  const mgrProjId = `gs-proj-mgr-${sfx}`;
  const mgrRepo = path.join(reposDir, "mgr");
  makeRepo(mgrRepo);
  db.insertProject({ id: mgrProjId, name: "GS-MGR", repoPath: mgrRepo, vaultPath: mgrRepo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: mgrProjId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: mgrProjId, agentId, engineSessionId: null, title: null, cwd: mgrRepo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const workers = [];
  for (const label of ["1", "2"]) {
    const projId = `gs-proj-${label}-${sfx}`, taskId = `gs-task-${label}-${sfx}`, workerId = `gs-wkr-${label}-${sfx}`;
    const repo = path.join(reposDir, `worker-${label}`);
    makeRepo(repo);
    db.insertProject({ id: projId, name: `GS-${label}`, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${agentId}-${label}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: taskId, projectId: projId, title: `GS-TASK-${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    worktrees.push(worktreePath);
    const file = `feature-${label}.txt`;
    fs.writeFileSync(path.join(worktreePath, file), `work for ${label}\n`);
    execSync(`git add . && git ${GIT_ID} commit -q -m "${file}"`, { cwd: worktreePath });
    db.insertSession({ id: workerId, projectId: projId, agentId: `${agentId}-${label}`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
    workers.push(workerId);
  }
  return { db, mgrId, workers };
}

// Card 9ef89fee — sibling of 4032ba4d's AttachResult fix, but a DIFFERENT mechanism: below, `Promise.all`
// races the UNTRACKED `confirmWorkerMerge` call directly (not the Tracked/PendingOpRegistry wrapper), so
// a genuine rejection (confirmWorkerMerge can throw for real under CPU starvation — a stranded-check or
// union-merge subprocess failing) rejects `Promise.all` itself and throws AT THE AWAIT, aborting the rest
// of this file before any later block runs. `Promise.allSettled` + explicit per-entry handling reports
// that rejection as a NAMED FAIL (with its error printed) and lets every remaining block still execute.
// DECISION (per the card): a rejection here is NOT tolerated — it's reported as a FAIL, not swallowed.
// Every block below asserts confirmWorkerMerge SUCCEEDS under the semaphore; a rejection failing that
// property is the exact thing this file exists to catch, so it must surface as a failing check, not be
// silently treated as an acceptable outcome of "racing under load".
async function raceReport(promises, labels, blockLabel) {
  const settled = await Promise.allSettled(promises);
  return settled.map((s, i) => {
    check(`(${blockLabel}) ${labels[i]} did not reject`, s.status === "fulfilled");
    if (s.status === "rejected") {
      console.log(`  -> (${blockLabel}) ${labels[i]} rejected: ${s.reason?.stack || s.reason}`);
    }
    return s.status === "fulfilled" ? s.value : null;
  });
}

try {
  // ── (A) default cap (1, no platform override) SERIALIZES two concurrent daemon-run gates ───────────
  {
    const sfx = `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-gs-repos-a-${sfx}`);
    const { db, mgrId, workers } = await seedTwoWorkers(sfx, reposDir);

    // (A) deliberately keeps a plain fixed sleep — do NOT replace it with (B)'s rendezvous barrier.
    // (A)'s maxActive===1 bound is guaranteed STRUCTURALLY by the real cap-1 GateSemaphore mutex: under
    // cap 1, worker[2]'s call cannot even reach fakeGate until worker[1]'s call has fully exited and
    // released the slot (release happens in runExclusive's finally, after fn resolves) — there is never
    // a moment where 2 calls are inside fakeGate concurrently, regardless of how slow pre-gate git work
    // is. There is no wall-clock coincidence here to de-race. Applying a 2-arrival barrier to THIS gate
    // would be wrong: arrived would never reach 2 while the cap holds, so the wait would always run out
    // the bound before falling through — turning a fast, reliable PASS into a slow one at best, and at
    // worst inviting a future edit to shrink/remove the bound and reintroduce a hang.
    let active = 0, maxActive = 0, calls = 0;
    const fakeGate = async () => {
      calls++; active++; maxActive = Math.max(maxActive, active);
      await sleep(150); // wide overlap window — real per-worktree git ops here take single-digit ms
      active--;
      return { passed: true };
    };
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });

    const [r1, r2] = await raceReport(
      [sessions.confirmWorkerMerge(mgrId, workers[0]), sessions.confirmWorkerMerge(mgrId, workers[1])],
      ["confirmWorkerMerge[1]", "confirmWorkerMerge[2]"],
      "A",
    );
    check("(A) both confirms ran the gate", calls === 2);
    check("(A) default cap 1 NEVER let both gates run concurrently", maxActive === 1);
    check("(A) both merges still succeeded (queued, not rejected)", r1?.merged === true && r2?.merged === true);
  }

  // ── (B) raising the cap to 2 lets both gates run TRULY concurrently ────────────────────────────────
  {
    const sfx = `b-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-gs-repos-b-${sfx}`);
    const { db, mgrId, workers } = await seedTwoWorkers(sfx, reposDir);
    db.setPlatformConfig({ maxConcurrentGates: 2 });

    // Rendezvous barrier, not a blind sleep: (B) needs to PROVE both gates are in-flight together, not
    // hope a fixed sleep outlasts whatever real git-prep work precedes it under host load (the bug this
    // card fixes — see the card body / commit message for the incident). Each fakeGate call announces
    // arrival; the 2nd arrival releases the barrier, so overlap is observed directly instead of timed.
    //
    // BOUND_MS is deliberately generous — 8s, not ~1s — by design, not oversight: on the PASS path the
    // barrier resolves near-instantly (no wall-clock wait at all), so a large bound costs nothing when
    // things work. It only matters on the FAIL path, where a genuinely-broken cap needs to give up and
    // report red rather than hang — and a fast-but-tight bound there just reintroduces a narrower version
    // of the same host-load flake this card exists to remove (pre-gate git-prep skew under load has to
    // stay well under BOUND_MS or a correct cap-2 semaphore fails anyway). Do not dial this down as
    // "wasteful" without re-reading this comment — this project has already shipped that exact mistake
    // once (6c3d2d3 widened a different timing constant and it still didn't hold).
    const BOUND_MS = 8000;
    let active = 0, maxActive = 0, calls = 0, arrived = 0, barrierTimedOut = false;
    let releaseBarrier;
    const barrier = new Promise((resolve) => { releaseBarrier = resolve; });
    const fakeGate = async () => {
      calls++; active++; maxActive = Math.max(maxActive, active);
      if (++arrived === 2) releaseBarrier();
      const outcome = await Promise.race([
        barrier.then(() => "resolved"),
        sleep(BOUND_MS).then(() => "timed-out"),
      ]);
      if (outcome === "timed-out") barrierTimedOut = true;
      active--;
      return { passed: true };
    };
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });

    const [r1, r2] = await raceReport(
      [sessions.confirmWorkerMerge(mgrId, workers[0]), sessions.confirmWorkerMerge(mgrId, workers[1])],
      ["confirmWorkerMerge[1]", "confirmWorkerMerge[2]"],
      "B",
    );
    check("(B) both confirms ran the gate", calls === 2);
    // A barrier timeout and a real cap-honoring serialization both observably leave maxActive at 1 — an
    // ambiguous signal is exactly what this de-race is supposed to remove, so the two are reported with
    // distinct, diagnosable messages rather than one shared label.
    check(
      barrierTimedOut
        ? `(B) cap 2 actually let both gates run concurrently — barrier timed out after ${BOUND_MS}ms: the two gates never overlapped within the bound, meaning either the semaphore cap is not being honored, or the host is pathologically slow (BOUND_MS is deliberately generous — rule out host load before suspecting the semaphore)`
        : "(B) cap 2 actually let both gates run concurrently (not a silent hardcoded serialize)",
      !barrierTimedOut && maxActive === 2,
    );
    check("(B) both merges succeeded", r1?.merged === true && r2?.merged === true);
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — GateSemaphore bounds concurrent daemon-executed heavy gate runs to the configured cap (default 1, serializing; raised, allowing real concurrency up to the cap), with no deadlock and no lost merges."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
