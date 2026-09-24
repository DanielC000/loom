import "./_guard.mjs"; // prod-guard (sets LOOM_TEST=1; see _guard.mjs)
// Card 68155573 — a merge gate's retry must CONTINUE its own admission (slot + repo guard + worktree held
// straight through the fail->retry gap), never re-queue.
//
// Driven directly on GateSemaphore (no Db, no LOOM_HOME). Every `fn` is a deferred this test settles by
// hand; admission and release are SYNCHRONOUS inside runExclusive, so each assertion reads state the test
// itself caused — no fixed waits and no negative assertion gated on a timer (waitUntil polls an observable).
//
// RED on pre-fix code: (T1)-(T3) fail because `runExclusive` ignored a 6th `next` argument, so the failed
// attempt released slot+guard and the queued same-repo merge B was admitted in that same tick. (T0) is the
// positive control: it drives the OLD shape (a second, fresh `runExclusive` as the "retry") and proves B IS
// admitted in the gap — i.e. this harness CAN observe the defect.
import { waitUntil, deferred } from "./_wait.mjs";

const { GateSemaphore } = await import("../dist/orchestration/gate-semaphore.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const REPO = "/repo/68155573";
const OTHER = "/repo/68155573-other";

const running = (sem, name) => sem.snapshot().entries.find((e) => e.sessionId === `sess-${name}` && e.phase === "running");
const isRunning = (sem, name) => running(sem, name) !== undefined;
const desc = (name, extra = {}) => ({ gateType: "merge", projectId: "p", sessionId: `sess-${name}`, opId: `op-${name}`, repoPath: REPO, ...extra });

/** A plain merge job (used for the queued sibling B): holds until `finish()`. */
function plain(sem, cap, name, extra = {}, gateType = "merge") {
  const d = deferred();
  const p = sem.runExclusive(cap, desc(name, { gateType, ...extra }), async () => d.promise, "high");
  return { done: p, finish: (v = name) => d.resolve(v) };
}

/** A chained merge: link 1 fails, `next` (unless overridden) returns ONE retry link. */
function chained(sem, cap, name, { extra = {}, nextImpl, retryFn } = {}) {
  const d1 = deferred();
  const d2 = deferred();
  const p = sem.runExclusive(
    cap, desc(name, extra),
    async () => d1.promise,
    "high",
    nextImpl ?? ((r) => (r.passed ? null : {
      descriptorPatch: { attempt: 2, priorAttemptMs: 111 },
      fn: retryFn ?? (async (_s, _sig, _h, _g, hold) => { const rr = await d2.promise; if (rr.hold) hold(); return rr; }),
    })),
  );
  return { done: p, fail1: () => d1.resolve({ passed: false }), pass1: () => d1.resolve({ passed: true }), retryPass: (hold = false) => d2.resolve({ passed: true, hold }), retryFail: () => d2.resolve({ passed: false }) };
}

/** Full-drain assertion: nothing held anywhere, and a fresh same-repo merge + same-worktree op admit at once. */
async function assertDrained(sem, label) {
  const internals = ["active", "activeMergeRepos", "activeWorktrees", "registry", "squashHolders"].map((k) => [k, sem[k]]);
  const sizes = Object.fromEntries(internals.map(([k, v]) => [k, typeof v === "number" ? v : v.size]));
  check(`${label}: nothing leaked (${JSON.stringify(sizes)})`, Object.values(sizes).every((n) => n === 0) && sem.snapshot().entries.length === 0);
  const probe = plain(sem, 1, `probe-${label.replace(/\W/g, "")}`, { worktreePath: "/wt/probe" });
  check(`${label}: a fresh same-repo merge is admitted immediately`, sem.snapshot().active === 1);
  probe.finish(); await probe.done;
}

// (T0) POSITIVE CONTROL — the OLD shape (fresh runExclusive as the retry): B IS admitted in the gap.
{
  const sem = new GateSemaphore();
  let bAtGap = null;
  const a1 = sem.runExclusive(2, desc("t0a"), async () => ({ passed: false }), "high");
  const b = plain(sem, 2, "t0b");
  check("(T0) precondition: B queued behind A's repo guard", !isRunning(sem, "t0b"));
  await a1.then(() => { bAtGap = isRunning(sem, "t0b"); });
  check("(T0) OLD shape: B is admitted the instant A's failed attempt settles (the defect this card fixes)", bAtGap === true);
  b.finish(); await b.done;
  await assertDrained(sem, "(T0)");
}

// (T1) CORE: A attempt 1 fails -> B must NOT be admitted before A's retry (cap 2, so cap is not the reason).
{
  const sem = new GateSemaphore();
  const a = chained(sem, 2, "t1a");
  const b = plain(sem, 2, "t1b");
  check("(T1) precondition: A running, B queued (repo-contended) with cap headroom", isRunning(sem, "t1a") && !isRunning(sem, "t1b") && sem.snapshot().active === 1);
  const since = running(sem, "t1a").since;
  a.fail1();
  await waitUntil(() => running(sem, "t1a")?.attempt === 2, { label: "(T1) A's retry link begins (attempt:2 running)" });
  const e = running(sem, "t1a");
  check("(T1) B is NOT admitted across the fail->retry gap", !isRunning(sem, "t1b") && sem.snapshot().active === 1);
  check("(T1) A reads phase:running attempt:2 with priorAttemptMs, never queued", e.phase === "running" && e.attempt === 2 && e.priorAttemptMs === 111);
  check("(T1) `since` keeps the ORIGINAL admission time; attemptStartedAt is the retry link's (>= since)", e.since === since && e.attemptStartedAt >= since && e.attemptStartedAt != null);
  check("(T1) A's slot + repo guard are still held (guard map keyed to A)", sem.activeMergeRepos.get(REPO) === "op-t1a");
  a.retryPass(true); // hold the guard through squash
  const r = await a.done;
  check("(T1) A settles with the retry's verdict", r.passed === true);
  check("(T1) still no B while A is mid-squash (guard held past release)", !isRunning(sem, "t1b") && sem.squashOnlySnapshot().length === 1);
  sem.endSquash(REPO, "op-t1a");
  await waitUntil(() => isRunning(sem, "t1b"), { label: "(T1) B admitted only after A's endSquash" });
  b.finish(); await b.done;
  await assertDrained(sem, "(T1)");
}

// (T1b) retry FAILS: guard/slot released exactly once, B then admitted.
{
  const sem = new GateSemaphore();
  const a = chained(sem, 2, "t1ba");
  const b = plain(sem, 2, "t1bb");
  a.fail1();
  await waitUntil(() => running(sem, "t1ba")?.attempt === 2, { label: "(T1b) retry begins" });
  check("(T1b) B not admitted mid-chain", !isRunning(sem, "t1bb"));
  a.retryFail();
  const r = await a.done;
  check("(T1b) failed retry verdict returned", r.passed === false);
  await waitUntil(() => isRunning(sem, "t1bb"), { label: "(T1b) B admitted once A's chain ends" });
  b.finish(); await b.done;
  await assertDrained(sem, "(T1b)");
}

// (T2) cap 1, cross-repo waiter C: the held slot is not handed to C in the gap either.
{
  const sem = new GateSemaphore();
  const a = chained(sem, 1, "t2a");
  const c = plain(sem, 1, "t2c", { repoPath: OTHER });
  check("(T2) precondition: C queued behind the cap", !isRunning(sem, "t2c"));
  a.fail1();
  await waitUntil(() => running(sem, "t2a")?.attempt === 2, { label: "(T2) retry begins" });
  check("(T2) C not admitted in the gap (slot held for the retry)", !isRunning(sem, "t2c") && sem.snapshot().active === 1);
  a.retryFail(); await a.done;
  await waitUntil(() => isRunning(sem, "t2c"), { label: "(T2) C admitted after the chain ends" });
  c.finish(); await c.done;
  await assertDrained(sem, "(T2)");
}

// (T3) a queued same-repo WORKER (writer-preference barrier, eb491463) and a queued same-WORKTREE op stay held.
{
  const sem = new GateSemaphore();
  const a = chained(sem, 3, "t3a", { extra: { worktreePath: "/wt/t3" } });
  const w = plain(sem, 3, "t3w", {}, "worker");
  const wt = plain(sem, 3, "t3wt", { repoPath: OTHER, worktreePath: "/wt/t3" }, "worker");
  check("(T3) precondition: worker + same-worktree op queued", !isRunning(sem, "t3w") && !isRunning(sem, "t3wt"));
  a.fail1();
  await waitUntil(() => running(sem, "t3a")?.attempt === 2, { label: "(T3) retry begins" });
  check("(T3) same-repo worker and same-worktree op both still queued mid-chain", !isRunning(sem, "t3w") && !isRunning(sem, "t3wt") && sem.activeWorktrees.has("/wt/t3"));
  a.retryFail(); await a.done;
  await waitUntil(() => isRunning(sem, "t3w") && isRunning(sem, "t3wt"), { label: "(T3) both admitted after the chain ends" });
  w.finish(); wt.finish(); await Promise.all([w.done, wt.done]);
  await assertDrained(sem, "(T3)");
}

// (L) LEAK TESTS — one per exit path; each must leave the semaphore fully drained AND admit a fresh merge.
{ // L1: `next` (attempt-1 continuation decision) throws
  const sem = new GateSemaphore();
  const boom = new Error("next-boom");
  const a = chained(sem, 2, "l1a", { nextImpl: () => { throw boom; } });
  const b = plain(sem, 2, "l1b");
  a.fail1();
  const err = await a.done.then(() => null, (e) => e);
  check("(L1) next() throw propagates out of runExclusive", err === boom);
  await waitUntil(() => isRunning(sem, "l1b"), { label: "(L1) B admitted (slot+guard released)" });
  b.finish(); await b.done;
  await assertDrained(sem, "(L1)");
}
{ // L2: the retry link's fn throws
  const sem = new GateSemaphore();
  const boom = new Error("retry-boom");
  const a = chained(sem, 2, "l2a", { retryFn: async () => { throw boom; } });
  const b = plain(sem, 2, "l2b");
  a.fail1();
  const err = await a.done.then(() => null, (e) => e);
  check("(L2) retry fn throw propagates", err === boom);
  await waitUntil(() => isRunning(sem, "l2b"), { label: "(L2) B admitted" });
  b.finish(); await b.done;
  await assertDrained(sem, "(L2)");
}
{ // L3: retry passes WITH a hold -> guard survives release, freed exactly by endSquash; a wrong-identity end is a no-op
  const sem = new GateSemaphore();
  const a = chained(sem, 2, "l3a");
  a.fail1();
  await waitUntil(() => running(sem, "l3a")?.attempt === 2, { label: "(L3) retry begins" });
  a.retryPass(true); await a.done;
  check("(L3) guard held after the chain (mid-squash), slot released", sem.activeMergeRepos.get(REPO) === "op-l3a" && sem.snapshot().active === 0);
  sem.endSquash(REPO, "op-someone-else");
  check("(L3) endSquash with a foreign identity is a no-op", sem.activeMergeRepos.get(REPO) === "op-l3a");
  sem.endSquash(REPO, "op-l3a");
  await assertDrained(sem, "(L3)");
}
{ // L4: retry passes WITHOUT a hold (only the LAST link's hold counts) -> everything freed at chain end
  const sem = new GateSemaphore();
  const holdOnLink1 = deferred();
  const p = sem.runExclusive(2, desc("l4a"), async (_s, _sig, _h, _g, hold) => { hold(); return holdOnLink1.promise; }, "high",
    (r) => (r.passed ? null : { descriptorPatch: { attempt: 2 }, fn: async () => ({ passed: true }) }));
  holdOnLink1.resolve({ passed: false });
  await p;
  check("(L4) link 1's hold does not leak into a retry link that never holds (per-link reset)", sem.activeMergeRepos.size === 0);
  await assertDrained(sem, "(L4)");
}
{ // L5: cancelRunning aborts the RETRY link (fresh controller per link); chain ends and drains
  const sem = new GateSemaphore();
  let link1Signal = null; let link2Signal = null;
  const d1 = deferred();
  const p = sem.runExclusive(2, desc("l5a"), async (_s, sig) => { link1Signal = sig; return d1.promise; }, "high",
    () => ({ descriptorPatch: { attempt: 2 }, fn: (_s, sig) => new Promise((_res, rej) => { link2Signal = sig; sig.addEventListener("abort", () => rej(new Error("aborted-retry"))); }) }));
  d1.resolve({ passed: false });
  await waitUntil(() => link2Signal !== null, { label: "(L5) retry link running" });
  check("(L5) each link gets its OWN AbortSignal", link1Signal !== link2Signal && !link2Signal.aborted);
  const id = sem.snapshot().entries[0].id;
  check("(L5) cancelRunning on the running retry link returns true", sem.cancelRunning(id, "test") === true);
  const err = await p.then(() => null, (e) => e);
  check("(L5) the aborted retry surfaces and the chain ends", err?.message === "aborted-retry");
  await assertDrained(sem, "(L5)");
}
{ // L6: three links (attempt 1, retry, resume); a throw at link 3 still drains
  const sem = new GateSemaphore();
  const boom = new Error("link3-boom");
  const p = sem.runExclusive(2, desc("l6a"), async () => ({ passed: false }), "high",
    () => ({ descriptorPatch: { attempt: 2 }, fn: async () => ({ passed: true }),
      next: () => ({ descriptorPatch: { attempt: 3 }, fn: async () => { throw boom; } }) }));
  const err = await p.then(() => null, (e) => e);
  check("(L6) link-3 throw propagates", err === boom);
  await assertDrained(sem, "(L6)");
}
{ // L7: `next` returning null on attempt 1 is byte-identical to the old single-admission release
  const sem = new GateSemaphore();
  const a = chained(sem, 2, "l7a", { nextImpl: () => null });
  const b = plain(sem, 2, "l7b");
  a.fail1();
  const r = await a.done;
  check("(L7) verdict returned unchanged; B admitted the instant A settles (old behaviour preserved)", r.passed === false && isRunning(sem, "l7b"));
  b.finish(); await b.done;
  await assertDrained(sem, "(L7)");
}
{ // L8: cancelQueued/cancelQueuedForSession cannot touch a mid-chain entry (it is RUNNING, never queued)
  const sem = new GateSemaphore();
  const a = chained(sem, 2, "l8a");
  a.fail1();
  await waitUntil(() => running(sem, "l8a")?.attempt === 2, { label: "(L8) retry begins" });
  const id = sem.snapshot().entries[0].id;
  check("(L8) cancelQueued(retry entry) is false — a retry can no longer be queued to be cancelled", sem.cancelQueued(id, "manual", "x") === false
    && sem.cancelQueuedForSession("sess-l8a", "merge", "p", "manual", "x").cancelled === false);
  a.retryPass(false); await a.done;
  await assertDrained(sem, "(L8)");
}

{ // L9: the CALLER's descriptor object is never mutated by a chain link's patch (the semaphore copies on entry)
  const sem = new GateSemaphore();
  const callerDesc = desc("l9a");
  const p = sem.runExclusive(2, callerDesc, async () => ({ passed: false }), "high",
    () => ({ descriptorPatch: { attempt: 2, priorAttemptMs: 7 }, fn: async () => ({ passed: false }) }));
  await p;
  check("(L9) caller descriptor untouched (no attempt/priorAttemptMs leaked onto it)", callerDesc.attempt === undefined && callerDesc.priorAttemptMs === undefined);
  await assertDrained(sem, "(L9)");
}
{ // L10: a cancelRunning that lands WHILE next() is awaited is carried onto the next link's signal, not lost
  const sem = new GateSemaphore();
  const nextGate = deferred();
  let link2Signal = null;
  const p = sem.runExclusive(2, desc("l10a"), async () => ({ passed: false }), "high",
    async () => { await nextGate.promise; return { descriptorPatch: { attempt: 2 }, fn: async (_s, sig) => { link2Signal = sig; return { passed: false }; } }; });
  await waitUntil(() => sem.snapshot().entries.length === 1, { label: "(L10) entry registered" });
  const id = sem.snapshot().entries[0].id;
  await waitUntil(() => sem.cancelRunning(id, "cancel-during-next") === true, { label: "(L10) cancelRunning accepted while next() is pending" });
  nextGate.resolve();
  await p;
  check("(L10) the abort is carried onto the next link's fresh signal (already aborted, reason preserved)", link2Signal?.aborted === true && link2Signal.reason === "cancel-during-next");
  await assertDrained(sem, "(L10)");
}

// (S) SNAPSHOT: per-link liveness resets; single-attempt entries report attemptStartedAt === since.
{
  const sem = new GateSemaphore();
  const seen = deferred();
  const d1 = deferred(); const d2 = deferred();
  const p = sem.runExclusive(2, desc("s1"), async (_s, _sig, hooks) => { hooks.onOutput(); hooks.onExtend(); return d1.promise; }, "high",
    () => ({ descriptorPatch: { attempt: 2, priorAttemptMs: 5 }, fn: async () => { seen.resolve(); return d2.promise; } }));
  await waitUntil(() => running(sem, "s1")?.extended === true, { label: "(S) link-1 fn ran (liveness hooks fired)" });
  const e1 = running(sem, "s1");
  check("(S) single attempt: attemptStartedAt === since, extended visible", e1.attemptStartedAt === e1.since && e1.extended === true && e1.lastOutputAt != null);
  d1.resolve({ passed: false });
  await seen.promise;
  const e2 = running(sem, "s1");
  check("(S) retry link resets lastOutputAt/extended (per-link liveness), attempt:2", e2.lastOutputAt === null && e2.extended === false && e2.attempt === 2);
  const queuedProbe = plain(sem, 2, "s1q");
  check("(S) a queued entry reports attemptStartedAt:null", sem.snapshot().entries.find((x) => x.phase === "queued")?.attemptStartedAt === null);
  d2.resolve({ passed: false }); await p;
  await waitUntil(() => isRunning(sem, "s1q"), { label: "(S) probe admitted" });
  queuedProbe.finish(); await queuedProbe.done;
  await assertDrained(sem, "(S)");
}

if (failures > 0) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log("\nOK");
