import "./_guard.mjs"; // prod-guard (sets LOOM_TEST=1; see _guard.mjs)
// Card eb491463 — a QUEUED merge must not be starved by later same-repo WORKER gates.
//
// The semaphore is driven directly (no Db, no LOOM_HOME): every `fn` is a deferred this test settles by
// hand, and admission is SYNCHRONOUS inside runExclusive/release, so every assertion reads state the test
// itself caused — no fixed waits, no negative assertion gated on a timer. Steps that need a release to
// propagate use waitUntil on the observable `started` flag.
//
// RED on pre-fix code: a worker arriving (or already queued) while a merge waits was admitted ahead of it,
// because a worker was only ever blocked by an ACTIVE merge holder.
import { waitUntil, deferred } from "./_wait.mjs";

const { GateSemaphore } = await import("../dist/orchestration/gate-semaphore.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const REPO = "/repo/eb491463";
const OTHER = "/repo/eb491463-other";

/** A fake gate: holds its slot until `finish()`. */
function job(sem, cap, gateType, name, repoPath) {
  const d = deferred();
  // `started` = ADMITTED (phase "running" in the live registry): admission is synchronous, whereas `fn`
  // itself only runs a microtask later, so a flag set inside `fn` would lag the state under test.
  const j = { name, get started() { return sem.snapshot().entries.some((e) => e.sessionId === `sess-${name}` && e.phase === "running"); }, finish: () => d.resolve(name) };
  j.done = sem.runExclusive(
    cap,
    { gateType, projectId: "p", sessionId: `sess-${name}`, opId: `op-${name}`, repoPath },
    async () => d.promise,
  );
  return j;
}
const queuedMergeEntry = (sem) => sem.snapshot().entries.find((e) => e.phase === "queued" && e.gateType === "merge");

// (1) The specimen: W1 running, M queued, then a NEW worker W2 arrives with cap headroom (1 of 2 active).
{
  const sem = new GateSemaphore();
  const w1 = job(sem, 2, "worker", "w1", REPO);
  const m = job(sem, 2, "merge", "m", REPO);
  check("(1) precondition: W1 running, cap has headroom, M queued and repoContended",
    w1.started && !m.started && sem.snapshot().active === 1 && queuedMergeEntry(sem)?.repoContended === true);
  const w2 = job(sem, 2, "worker", "w2", REPO);
  check("(1) a NEW same-repo worker is queued behind the waiting merge, NOT admitted ahead of it", !w2.started);
  w1.finish();
  await waitUntil(() => m.started, { label: "(1) M admitted once W1 releases" });
  check("(1) the merge is admitted first; W2 is still held back while the merge runs", m.started && !w2.started);
  m.finish();
  await waitUntil(() => w2.started, { label: "(1) W2 admitted after M releases" });
  w2.finish();
  await Promise.all([w1.done, m.done, w2.done]);
  check("(1) registry drained", sem.snapshot().entries.length === 0 && sem.snapshot().active === 0);
}

// (2) Rolling overlap: worker n+1 arrives before worker n finishes — the pattern that starved the specimen.
{
  const sem = new GateSemaphore();
  const w1 = job(sem, 2, "worker", "r1", REPO);
  const m = job(sem, 2, "merge", "rm", REPO);
  const w2 = job(sem, 2, "worker", "r2", REPO);
  const w3 = job(sem, 2, "worker", "r3", REPO);
  check("(2) W2/W3 queued behind the merge", !w2.started && !w3.started && !m.started);
  w1.finish();
  await waitUntil(() => m.started, { label: "(2) M admitted after the ONLY running worker drains" });
  check("(2) merge admitted despite two later-queued workers; they stay queued", !w2.started && !w3.started);
  m.finish();
  await waitUntil(() => w2.started && w3.started, { label: "(2) both workers admitted after the merge (cap 2)" });
  w2.finish(); w3.finish();
  await Promise.all([w1.done, m.done, w2.done, w3.done]);
}

// (3) Scope: a worker on a DIFFERENT repo is unaffected by the barrier.
{
  const sem = new GateSemaphore();
  const w1 = job(sem, 3, "worker", "s1", REPO);
  const m = job(sem, 3, "merge", "sm", REPO);
  const wOther = job(sem, 3, "worker", "so", OTHER);
  check("(3) a worker on another repo is admitted immediately while a merge waits on REPO", wOther.started && !m.started);
  w1.finish(); wOther.finish();
  await waitUntil(() => m.started, { label: "(3) M admitted" });
  m.finish();
  await Promise.all([w1.done, m.done, wOther.done]);
}

// (4) Control: worker-vs-worker with NO merge waiting stays fully concurrent (e4701333's rule is intact).
{
  const sem = new GateSemaphore();
  const a = job(sem, 2, "worker", "c1", REPO);
  const b = job(sem, 2, "worker", "c2", REPO);
  check("(4) two same-repo workers with no merge waiting run concurrently", a.started && b.started && sem.snapshot().active === 2);
  a.finish(); b.finish();
  await Promise.all([a.done, b.done]);
}

// (5) No-deadlock: cap saturated. Same-repo workers W1,W2 hold BOTH slots, M queued, W3 queued.
{
  const sem = new GateSemaphore();
  const w1 = job(sem, 2, "worker", "d1", REPO);
  const w2 = job(sem, 2, "worker", "d2", REPO);
  const m = job(sem, 2, "merge", "dm", REPO);
  const w3 = job(sem, 2, "worker", "d3", REPO);
  check("(5) cap full of same-repo workers; M and W3 queued", w1.started && w2.started && !m.started && !w3.started);
  w1.finish();
  await Promise.all([w1.done]);
  check("(5) freeing ONE slot does not admit W3 ahead of M (M still blocked by W2, W3 barred) — slot idles, by design", !m.started && !w3.started);
  w2.finish();
  await waitUntil(() => m.started, { label: "(5) M admitted once the last worker drains" });
  m.finish();
  await waitUntil(() => w3.started, { label: "(5) W3 admitted after M" });
  w3.finish();
  await Promise.all([w2.done, m.done, w3.done]);
  check("(5) everything settled, nothing wedged", sem.snapshot().entries.length === 0);
}

// (5b) No-deadlock: cap saturated by UNRELATED-repo workers; a same-repo worker queued BEFORE the merge.
{
  const sem = new GateSemaphore();
  const x1 = job(sem, 2, "worker", "e1", OTHER);
  const x2 = job(sem, 2, "worker", "e2", OTHER);
  const w = job(sem, 2, "worker", "ew", REPO);
  const m = job(sem, 2, "merge", "em", REPO);
  check("(5b) cap full; W then M queued", !w.started && !m.started);
  x1.finish();
  await waitUntil(() => m.started, { label: "(5b) M admitted ahead of the earlier-queued same-repo worker" });
  check("(5b) the barrier reorders W behind M, but a free slot is never wedged", m.started && !w.started);
  m.finish(); x2.finish();
  await waitUntil(() => w.started, { label: "(5b) W admitted after M" });
  w.finish();
  await Promise.all([x1.done, x2.done, w.done, m.done]);
}

// (6) Cancelling the queued merge LIFTS the barrier: held-back workers are granted into free cap at once.
{
  const sem = new GateSemaphore();
  const w1 = job(sem, 3, "worker", "k1", REPO);
  const m = job(sem, 3, "merge", "km", REPO);
  const w2 = job(sem, 3, "worker", "k2", REPO);
  const w3 = job(sem, 3, "worker", "k3", REPO);
  check("(6) W2/W3 held back by the queued merge despite free cap", !w2.started && !w3.started && sem.snapshot().active === 1);
  const mergeId = queuedMergeEntry(sem).id;
  const cancelled = sem.cancelQueued(mergeId, "manual", "test cancel");
  const mergeOutcome = await m.done.then(() => "resolved", () => "rejected");
  check("(6) the queued merge cancelled (its runExclusive rejects)", cancelled === true && mergeOutcome === "rejected");
  await waitUntil(() => w2.started && w3.started, { label: "(6) both held-back workers admitted with no slot release" });
  w1.finish(); w2.finish(); w3.finish();
  await Promise.all([w1.done, w2.done, w3.done]);
}

// (7) Two merges on one repo stay serialized (the pre-existing rule; the barrier does not touch it).
{
  const sem = new GateSemaphore();
  const m1 = job(sem, 2, "merge", "g1", REPO);
  const m2 = job(sem, 2, "merge", "g2", REPO);
  check("(7) second same-repo merge queued while the first runs", m1.started && !m2.started);
  m1.finish();
  await waitUntil(() => m2.started, { label: "(7) second merge admitted after the first" });
  m2.finish();
  await Promise.all([m1.done, m2.done]);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
