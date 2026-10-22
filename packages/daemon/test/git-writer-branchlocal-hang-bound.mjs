import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 40a264d3 (from taskless Code Reviewer 5628333c's finding M4) — `repo-lock.ts`'s
// `withCanonicalIndexLock` explicitly REJECTS a lock-level timeout *because* it requires every caller to
// bound its OWN git calls ("fn is GUARANTEED to settle within a bounded time on its own"). `GitWriter`
// broke that precondition at two sites INSIDE the lock: `checkout()`'s `git.branchLocal()` and
// `commit()`'s `git.revparse(["HEAD"])` were bare `await`s with no `withTimeout` race, unlike every
// sibling call in the same two methods (and unlike `pendingPushSummary()`'s own `branchLocal()` call,
// which was already correctly wrapped — the in-file divergence proof for this exact bug).
//
// MEASUREMENT (the reviewer's own, re-derive-able): `boundedSimpleGit`'s `block` timeout is IDLE, not
// ELAPSED — a slow-but-TALKING child is unbounded. A never-settling `branchLocal()`/`revparse()` inside
// the lock means `fn` in `withCanonicalIndexLock` never settles, so via `prior.then(fn, fn)` (repo-lock.ts)
// EVERY LATER caller for that repo — including every squash merge — queues behind it PERMANENTLY.
//
// THE FIX: wrap both calls in the same `withTimeout` race their siblings already use, and give `GitWriter`
// an injectable `gitFactory` seam (mirroring git/reader.ts's `ReaderGitDeps` / git/worktrees.ts's
// `BoundedGitDeps`) so this can be proven WITHOUT a real hung git child.
//
// 🔴 DO NOT test this with a hung REAL process — this project has a live P0 scar
// ([[worktree-gc-threadpool-leak]]): a retry loop over a genuinely hung real operation leaked libuv
// threadpool threads and wedged the daemon. This test uses an INJECTED never-settling fake instead — no
// real subprocess, no real timer starvation risk, exactly what the new seam exists for.
//
// Asserts BOTH halves of the DoD-3 spec, for EACH of checkout()'s two in-lock bounded-call sites
// separately (round 3, card 59e53710 — the original single-case version hung the fake's branchLocal()
// unconditionally; once round 2 of 59e53710 added an EARLIER `branchLocal()` existence check at ~:492,
// that hang always fired there first and the test never actually reached the POST-checkout call at ~:518
// this card was filed to prove. A loose `git branch.*exceeded` regex then matched either call's label, so
// the gap was invisible: removing `withTimeout` from the ~:518 call alone still passed every assertion.
// Round 3 of 59e53710 then replaced the existence check with a `raw(["for-each-ref",...])` call (a
// detached-HEAD fix, unrelated to this card), so checkout()'s two sites are now DIFFERENT methods on the
// fake — a `raw()` existence check and a `branchLocal()` post-checkout read — tested as cases 1a/1b below):
//   1. checkout() with a never-settling call AT THAT SITE rejects within ~gitLocalMs (not forever), and
//      its structured error names THAT EXACT call's label (never the sibling site's).
//   2. A SECOND checkout() call on the SAME repo (a healthy, fast fake) is still ADMITTED promptly — this
//      is the actual LOCK-DAMAGE proof, not just "did the first call itself settle."
// commit()'s revparse() is proven the same shape via a THIRD case, since it's the second of the two
// in-lock sites the card names.
//
// Run: 1) build daemon (pnpm build), 2) node test/git-writer-branchlocal-hang-bound.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { GitWriter } = await import("../dist/git/writer.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Races `promise` against a `ms`-bounded sentinel so this test's own runner can never hang forever even if
// the op under test genuinely never settles (the pre-fix behavior) — a fired guard reads as "did not
// settle within any reasonable window", not a real pass/fail ambiguity. Same idiom as
// test/merge-hang-does-not-wedge-queue.mjs's own `guard`.
const guard = (ms, label) => new Promise((resolve) => setTimeout(() => resolve({ __guardFired: label }), ms));

/** A fake git client — no real subprocess, no real timer. `hang` names which method(s)/call never settle;
 *  every other method resolves immediately with innocuous data. */
function makeFakeGit(hang = {}) {
  return {
    checkout: async () => ({}),
    checkoutLocalBranch: async () => ({}),
    // @decision 59e53710 — `checkout()`'s POST-checkout read (~:518, card 40a264d3's own DoD-3 site, the
    // one this file was filed to prove bounded) is the ONLY `branchLocal()` call left in `checkout()` as
    // of round 3 — the pre-spawn existence check now uses `raw(["for-each-ref",...])` instead (see below).
    branchLocal: () => (hang.branchLocal
      ? new Promise(() => { /* never settles */ })
      : Promise.resolve({ current: "main", all: ["main", "x", "y"] })),
    status: async () => ({ isClean: () => false, files: [] }),
    raw: async (args) => {
      // @decision 59e53710 (round 3) — `checkout()`'s existence check reads `refs/heads/` via
      // `for-each-ref`, never `branchLocal()` (a detached-HEAD pseudo-entry can false-match it — see the
      // decision record). `hang.forEachRef` hangs ONLY this call, never the unrelated `["add",...]` raw
      // call `commit()` uses, so a case proving one site is bounded can't silently miss the other.
      if (Array.isArray(args) && args[0] === "for-each-ref") {
        return hang.forEachRef
          ? new Promise(() => { /* never settles */ })
          : "refs/heads/main\nrefs/heads/x\nrefs/heads/y\n";
      }
      return Array.isArray(args) && args[0] === "add" ? "" : "";
    },
    commit: async () => ({ commit: "" }), // empty .commit forces commit()'s fallback revparse(["HEAD"]) path
    // `hang.revparse` must hang ONLY the ["HEAD"] call this test exists to prove bounded — never the
    // operational-home guard's OWN, EARLIER `revparse(["--show-toplevel"])` probe (card f9360c84 round 3:
    // every write now pays that bounded call FIRST). An args-blind hang here makes the guard's own
    // fail-closed probe-timeout refusal fire first and mask the specific in-lock site under test.
    revparse: async (args) => (hang.revparse && Array.isArray(args) && args[0] === "HEAD")
      ? new Promise(() => { /* never settles */ })
      : "deadbeefcafe",
  };
}

// The DoD's own example uses `gitLocalMs: 200`, but `GIT_TIMEOUT_FLOOR_MS` (writer.ts, = 1000) floors any
// sub-second request — a pre-existing guard, unrelated to this fix, "so a misconfigured (sub-second) value
// is FLOORED ... so a bad config can never make every git write fail-fast." Requesting 200ms here would
// silently test a 1000ms bound instead and make the budget-matching assertion below meaningless (it would
// pass by coincidence against the floor, not against the value this test actually asked for) — so this
// uses a value ABOVE the floor, to keep the assertion honest about what it's proving.
const GIT_LOCAL_MS = 1_500;
const GUARD_MS = 6_000; // this TEST's own patience — well above GIT_LOCAL_MS so a real bound settles fast,
                         // well below "forever" so a genuinely wedged run doesn't hang the suite.

const repo = path.join(os.tmpdir(), `loom-gitwriter-hangbound-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });

try {
  // ── 1a. checkout(): a never-settling for-each-ref EXISTENCE CHECK (~:492) must not hang ──
  {
    const hangingWriter = new GitWriter(repo, {
      gitLocalMs: GIT_LOCAL_MS,
      gitFactory: () => makeFakeGit({ forEachRef: true }),
    });

    const t0 = performance.now(); // MONOTONIC (survives an NTP/backward clock step)
    const checkoutResult = await Promise.race([hangingWriter.checkout("x"), guard(GUARD_MS, "checkout-existence")]);
    const elapsedMs = performance.now() - t0;

    check(`[checkout existence-check] settles on its own within its bounded timeout (${Math.round(elapsedMs)}ms, ` +
      `cap ~${GIT_LOCAL_MS}ms) — a never-settling for-each-ref (the pre-spawn existence check) does NOT hang it forever`,
      checkoutResult?.__guardFired !== "checkout-existence" && elapsedMs < GUARD_MS);
    check("[checkout existence-check] reports a structured failure (never a hang, never a false success)",
      checkoutResult?.ok === false);
    check(`[checkout existence-check] the failure names THIS EXACT call's label, not the sibling branchLocal() ` +
      `site's ("git for-each-ref (existence check) exceeded ${GIT_LOCAL_MS}ms") — actual: "${checkoutResult?.error}"`,
      typeof checkoutResult?.error === "string" &&
        new RegExp(`^git for-each-ref \\(existence check\\) exceeded ${GIT_LOCAL_MS}ms`).test(checkoutResult.error));

    // THE LOCK-DAMAGE PROOF: a SECOND caller on the SAME repo must still be admitted promptly — not
    // queued forever behind the first call's now-settled (rejected, but previously would-have-been
    // never-settling) op. This is what actually distinguishes "this op timed out" from "the shared
    // per-repo lock is now wedged for every future caller."
    const healthyWriter = new GitWriter(repo, {
      gitLocalMs: GIT_LOCAL_MS,
      gitFactory: () => makeFakeGit({}),
    });
    const t1 = performance.now();
    const secondResult = await Promise.race([healthyWriter.checkout("y"), guard(GUARD_MS, "second-checkout-existence")]);
    const elapsedMs2 = performance.now() - t1;
    check(`[lock] a SECOND checkout() call on the SAME repo is still admitted (settled in ${Math.round(elapsedMs2)}ms) ` +
      `— not queued forever behind the first call's unbounded existence-check for-each-ref`,
      secondResult?.__guardFired !== "second-checkout-existence");
    check("[lock] the second call actually succeeded (real admission, not just 'didn't hang')",
      secondResult?.ok === true && secondResult?.branch === "main");
  }

  // ── 1b. checkout(): a never-settling branchLocal() POST-CHECKOUT READ (~:518) must not hang either —
  // this is card 40a264d3's own original DoD-3 site, and the one the lost-guard regression (see this
  // file's header comment) let slip past undetected. ──
  {
    const hangingWriter = new GitWriter(repo, {
      gitLocalMs: GIT_LOCAL_MS,
      gitFactory: () => makeFakeGit({ branchLocal: true }),
    });

    const t0 = performance.now();
    const checkoutResult = await Promise.race([hangingWriter.checkout("x"), guard(GUARD_MS, "checkout")]);
    const elapsedMs = performance.now() - t0;

    check(`[checkout] settles on its own within its bounded timeout (${Math.round(elapsedMs)}ms, cap ~${GIT_LOCAL_MS}ms) ` +
      `— a never-settling branchLocal() (the post-spawn read) does NOT hang it forever`,
      checkoutResult?.__guardFired !== "checkout" && elapsedMs < GUARD_MS);
    check("[checkout] reports a structured failure (never a hang, never a false success)",
      checkoutResult?.ok === false);
    check(`[checkout] the failure names THIS EXACT call's label, not the sibling for-each-ref site's ` +
      `("git branch exceeded ${GIT_LOCAL_MS}ms") — actual: "${checkoutResult?.error}"`,
      typeof checkoutResult?.error === "string" &&
        new RegExp(`^git branch exceeded ${GIT_LOCAL_MS}ms`).test(checkoutResult.error));

    // THE LOCK-DAMAGE PROOF: a SECOND caller on the SAME repo must still be admitted promptly — not
    // queued forever behind the first call's now-settled (rejected, but previously would-have-been
    // never-settling) op. This is what actually distinguishes "this op timed out" from "the shared
    // per-repo lock is now wedged for every future caller."
    const healthyWriter = new GitWriter(repo, {
      gitLocalMs: GIT_LOCAL_MS,
      gitFactory: () => makeFakeGit({}),
    });
    const t1 = performance.now();
    const secondResult = await Promise.race([healthyWriter.checkout("y"), guard(GUARD_MS, "second-checkout")]);
    const elapsedMs2 = performance.now() - t1;
    check(`[lock] a SECOND checkout() call on the SAME repo is still admitted (settled in ${Math.round(elapsedMs2)}ms) ` +
      `— not queued forever behind the first call's unbounded post-checkout branchLocal()`,
      secondResult?.__guardFired !== "second-checkout");
    check("[lock] the second call actually succeeded (real admission, not just 'didn't hang')",
      secondResult?.ok === true && secondResult?.branch === "main");
  }

  // ── 3. commit(): a never-settling revparse(["HEAD"]) fallback must not hang either ──
  {
    const hangingWriter = new GitWriter(repo, {
      gitLocalMs: GIT_LOCAL_MS,
      gitFactory: () => makeFakeGit({ revparse: true }),
    });
    const t0 = performance.now();
    const commitResult = await Promise.race([hangingWriter.commit("msg"), guard(GUARD_MS, "commit")]);
    const elapsedMs = performance.now() - t0;
    check(`[commit] settles on its own within its bounded timeout (${Math.round(elapsedMs)}ms, cap ~${GIT_LOCAL_MS}ms) ` +
      `— a never-settling revparse(["HEAD"]) fallback does NOT hang it forever`,
      commitResult?.__guardFired !== "commit" && elapsedMs < GUARD_MS);
    check("[commit] reports a structured failure (never a hang, never a false success)",
      commitResult?.ok === false);
    check(`[commit] the failure names the specific bounded call and its budget ` +
      `("git rev-parse HEAD ... exceeded ${GIT_LOCAL_MS}ms") — actual: "${commitResult?.error}"`,
      typeof commitResult?.error === "string" && new RegExp(`git rev-parse HEAD.*exceeded ${GIT_LOCAL_MS}ms`).test(commitResult.error));

    // Same lock-damage proof as checkout(), for commit()'s own site.
    const healthyWriter = new GitWriter(repo, {
      gitLocalMs: GIT_LOCAL_MS,
      gitFactory: () => makeFakeGit({}),
    });
    const t1 = performance.now();
    const secondResult = await Promise.race([healthyWriter.commit("msg2"), guard(GUARD_MS, "second-commit")]);
    const elapsedMs2 = performance.now() - t1;
    check(`[lock] a SECOND commit() call on the SAME repo is still admitted (settled in ${Math.round(elapsedMs2)}ms) ` +
      `— not queued forever behind the first call's unbounded revparse()`,
      secondResult?.__guardFired !== "second-commit");
    check("[lock] the second call actually succeeded", secondResult?.ok === true);
  }
} finally {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — GitWriter's checkout()/commit() in-lock git calls are bounded even against a " +
    "never-settling child (injected fake, not a real hung process), and a subsequent caller on the same " +
    "repo is never wedged behind one that timed out."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
